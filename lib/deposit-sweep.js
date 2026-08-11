// Core on-chain sweep logic, shared between scripts/sweep-deposits.js (owns its own Mongo
// connection lifecycle) and any HTTP-triggered invocation (reuses the app's already-open
// connection). This module never calls mongoose.connect/disconnect itself.
import Deposit from "../models/deposit_model.js";
import DepositAddress from "../models/deposit_address_model.js";
import {
  deriveTronAccount,
  HOT_WALLET_INDEX,
  getTrxBalance,
  getTrc20RawBalance,
  sendTrx,
  sendTrc20,
  waitForConfirmation,
} from "./tron-wallet.js";
import { tryAcquireLock, releaseLock, checkStuckLock } from "./cron-lock.js";
import { sendAlert } from "./alert.js";

const USDT_CONTRACT_ADDRESS = process.env.USDT_CONTRACT_ADDRESS || "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
const SWEEP_TRX_FUNDING_AMOUNT = Number(process.env.SWEEP_TRX_FUNDING_AMOUNT || 15);
const SWEEP_TRX_MIN_THRESHOLD = Number(process.env.SWEEP_TRX_MIN_THRESHOLD || 15);
const MAX_SWEEP_ATTEMPTS = 3;

const LOCK_NAME = "sweep-deposits";
// A normal sweep run finishes well within a few minutes; 15 min gives generous headroom for one
// unusually slow run (several addresses each waiting out on-chain confirmations) before a stuck
// lock both self-heals (gets reclaimed) and triggers the "check manually" alert below — same
// constant serves both purposes since they describe the same real-world event from two angles.
const LOCK_STALE_MS = Number(process.env.SWEEP_LOCK_STALE_MS || 15 * 60 * 1000);

async function markGroup(deposits, update) {
  await Deposit.updateMany({ _id: { $in: deposits.map((d) => d._id) } }, { $set: update });
}

async function markGroupFailed(deposits, errorMessage) {
  await Deposit.updateMany({ _id: { $in: deposits.map((d) => d._id) } }, { $set: { sweepStatus: "failed" }, $inc: { sweepAttempts: 1 } });
}

// Grouped by address (not by individual Deposit record) so a shared address with several pending
// deposits is only swept once; funding decisions are based on the REAL on-chain TRX balance at the
// time of the check, never on whether fundingTxid is already recorded (a crash between
// broadcasting the funding tx and writing fundingTxid would otherwise cause a redundant — but
// harmless — second funding send).
async function sweepAddress(hotWallet, address, deposits, log) {
  // Deposit records created before `derivationIndex` was added to the schema have it as null —
  // fall back to looking it up on the DepositAddress this address belongs to, instead of failing.
  let derivationIndex = deposits[0].derivationIndex;
  if (derivationIndex === null || derivationIndex === undefined) {
    const depositAddress = await DepositAddress.findOne({ address });
    if (!depositAddress) throw new Error(`No DepositAddress found for ${address} to recover its derivationIndex`);
    derivationIndex = depositAddress.derivationIndex;
    log(`[INDEX RECOVERED] address=${address} derivationIndex=${derivationIndex} (looked up, missing on the Deposit record)`);
  }

  const { privateKey } = deriveTronAccount(derivationIndex);

  const trxBalance = await getTrxBalance(address);
  let fundingTxid = null;
  if (trxBalance < SWEEP_TRX_MIN_THRESHOLD) {
    log(`[FUNDING] address=${address} trxBalance=${trxBalance} < ${SWEEP_TRX_MIN_THRESHOLD} — sending ${SWEEP_TRX_FUNDING_AMOUNT} TRX...`);
    fundingTxid = await sendTrx(hotWallet.privateKey, address, SWEEP_TRX_FUNDING_AMOUNT);
    await waitForConfirmation(fundingTxid);
    await markGroup(deposits, { sweepStatus: "funded", fundingTxid });
    log(`[FUNDED] address=${address} fundingTxid=${fundingTxid}`);
  } else {
    log(`[FUNDING SKIPPED] address=${address} trxBalance=${trxBalance} already >= ${SWEEP_TRX_MIN_THRESHOLD}`);
    await markGroup(deposits, { sweepStatus: "funded" });
  }

  const rawBalance = await getTrc20RawBalance(address, USDT_CONTRACT_ADDRESS);
  if (BigInt(rawBalance) <= 0n) {
    throw new Error("USDT balance is 0 — already swept by a previous run?");
  }

  const sweepTxid = await sendTrc20(privateKey, hotWallet.address, USDT_CONTRACT_ADDRESS, rawBalance);
  await waitForConfirmation(sweepTxid, { requireContractSuccess: true });
  await markGroup(deposits, { sweepStatus: "swept", sweepTxid });
  log(`[SWEPT] address=${address} rawAmount=${rawBalance} sweepTxid=${sweepTxid} -> hot wallet ${hotWallet.address}`);

  return { address, derivationIndex, fundingTxid, sweepTxid, rawAmount: rawBalance };
}

export async function runDepositSweep({ log = () => {} } = {}) {
  const acquired = await tryAcquireLock(LOCK_NAME, LOCK_STALE_MS);
  if (!acquired) {
    log("[SKIPPED] Another sweep is already in progress (lock held) — skipping this run.");
    // Distinguishes a run that's legitimately still working from a dead one that crashed without
    // releasing the lock — only fires once per stuck episode (see checkStuckLock).
    const heldForMs = await checkStuckLock(LOCK_NAME, LOCK_STALE_MS);
    if (heldForMs !== null) {
      const minutes = Math.round(heldForMs / 60000);
      const message = `sweep-deposits.js: lock held for ~${minutes} min without release — likely a dead/stuck run, check manually.`;
      log(`[STUCK LOCK] ${message}`);
      await sendAlert(`🔒 ${message}`);
    }
    return { skipped: true, reason: "locked" };
  }

  try {
    const hotWallet = deriveTronAccount(HOT_WALLET_INDEX);

    const candidates = await Deposit.find({
      $or: [
        { sweepStatus: "pending" },
        { sweepStatus: "funded" },
        { sweepStatus: "failed", sweepAttempts: { $lt: MAX_SWEEP_ATTEMPTS } },
      ],
    });

    const byAddress = new Map();
    for (const deposit of candidates) {
      if (!byAddress.has(deposit.address)) byAddress.set(deposit.address, []);
      byAddress.get(deposit.address).push(deposit);
    }

    log(`Sweeping ${byAddress.size} address(es) (${candidates.length} deposit record(s)) toward hot wallet ${hotWallet.address}...`);

    const swept = [];
    const failed = [];

    for (const [address, deposits] of byAddress) {
      try {
        const result = await sweepAddress(hotWallet, address, deposits, log);
        swept.push(result);
      } catch (error) {
        await markGroupFailed(deposits, error.message);
        log(`[SWEEP FAILED] address=${address} deposit(s)=${deposits.length}: ${error.message}`);
        failed.push({ address, error: error.message, depositCount: deposits.length });
      }
    }

    return { hotWallet: hotWallet.address, addressesChecked: byAddress.size, depositsChecked: candidates.length, swept, failed };
  } finally {
    await releaseLock(LOCK_NAME);
  }
}
