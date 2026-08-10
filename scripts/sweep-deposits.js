// Manual on-chain sweep worker. Run with: node scripts/sweep-deposits.js
//
// Moves confirmed USDT deposits from each deposit address to the consolidated hot wallet
// (derivation index 0). Separate step from crediting the user's internal balance (already done by
// detect-deposits.js) — this only moves the actual on-chain funds.
//
// Safe to re-run: grouped by address (not by individual Deposit record) so a shared address with
// several pending deposits is only swept once; funding decisions are based on the REAL on-chain
// TRX balance at the time of the check, never on whether fundingTxid happens to be recorded yet
// (a crash between broadcasting the funding tx and writing fundingTxid to the DB would otherwise
// cause a redundant — but harmless — second funding send).
import dotenv from "dotenv";
import mongoose from "mongoose";
import Deposit from "../models/deposit_model.js";
import {
  deriveTronAccount,
  HOT_WALLET_INDEX,
  getTrxBalance,
  getTrc20RawBalance,
  sendTrx,
  sendTrc20,
  waitForConfirmation,
} from "../lib/tron-wallet.js";

dotenv.config();

const USDT_CONTRACT_ADDRESS = process.env.USDT_CONTRACT_ADDRESS || "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
const SWEEP_TRX_FUNDING_AMOUNT = Number(process.env.SWEEP_TRX_FUNDING_AMOUNT || 15);
const SWEEP_TRX_MIN_THRESHOLD = Number(process.env.SWEEP_TRX_MIN_THRESHOLD || 15);
const MAX_SWEEP_ATTEMPTS = 3;

async function markGroup(deposits, update) {
  await Deposit.updateMany({ _id: { $in: deposits.map((d) => d._id) } }, { $set: update });
}

async function markGroupFailed(deposits, errorMessage) {
  await Deposit.updateMany({ _id: { $in: deposits.map((d) => d._id) } }, { $set: { sweepStatus: "failed" }, $inc: { sweepAttempts: 1 } });
  console.error(`[SWEEP FAILED] address=${deposits[0].address} deposit(s)=${deposits.length}: ${errorMessage}`);
}

async function sweepAddress(hotWallet, address, deposits) {
  const derivationIndex = deposits[0].derivationIndex;
  const { privateKey } = deriveTronAccount(derivationIndex);

  // Fund with TRX if needed. Decided from the real on-chain balance right now, not from whether
  // fundingTxid is already recorded — see the module comment above.
  const trxBalance = await getTrxBalance(address);
  if (trxBalance < SWEEP_TRX_MIN_THRESHOLD) {
    console.log(`[FUNDING] address=${address} trxBalance=${trxBalance} < ${SWEEP_TRX_MIN_THRESHOLD} — sending ${SWEEP_TRX_FUNDING_AMOUNT} TRX...`);
    const fundingTxid = await sendTrx(hotWallet.privateKey, address, SWEEP_TRX_FUNDING_AMOUNT);
    await waitForConfirmation(fundingTxid);
    await markGroup(deposits, { sweepStatus: "funded", fundingTxid });
    console.log(`[FUNDED] address=${address} fundingTxid=${fundingTxid}`);
  } else {
    console.log(`[FUNDING SKIPPED] address=${address} trxBalance=${trxBalance} already >= ${SWEEP_TRX_MIN_THRESHOLD}`);
    await markGroup(deposits, { sweepStatus: "funded" });
  }

  // Sweep the address's FULL current USDT balance (not just this batch's recorded amounts) — this
  // naturally covers anything else that landed on the same address before it got swept.
  const rawBalance = await getTrc20RawBalance(address, USDT_CONTRACT_ADDRESS);
  if (BigInt(rawBalance) <= 0n) {
    throw new Error("USDT balance is 0 — already swept by a previous run?");
  }

  const sweepTxid = await sendTrc20(privateKey, hotWallet.address, USDT_CONTRACT_ADDRESS, rawBalance);
  await waitForConfirmation(sweepTxid, { requireContractSuccess: true });
  await markGroup(deposits, { sweepStatus: "swept", sweepTxid });
  console.log(`[SWEPT] address=${address} rawAmount=${rawBalance} sweepTxid=${sweepTxid} -> hot wallet ${hotWallet.address}`);
}

async function run() {
  const mongoUri = process.env.MONGO_UI;
  if (!mongoUri) throw new Error("MONGO_UI environment variable is not set");
  await mongoose.connect(mongoUri);

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

  console.log(`Sweeping ${byAddress.size} address(es) (${candidates.length} deposit record(s)) toward hot wallet ${hotWallet.address}...`);

  for (const [address, deposits] of byAddress) {
    try {
      await sweepAddress(hotWallet, address, deposits);
    } catch (error) {
      await markGroupFailed(deposits, error.message);
    }
  }

  await mongoose.disconnect();
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("sweep-deposits failed:", error);
    process.exit(1);
  });
