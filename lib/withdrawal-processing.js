// Core withdrawal-processing logic, shared between scripts/process-withdrawals.js (owns its own
// Mongo connection lifecycle) and any HTTP-triggered invocation (reuses the app's already-open
// connection). This module never calls mongoose.connect/disconnect itself — same split as
// lib/deposit-detection.js / lib/deposit-sweep.js.
import mongoose from "mongoose";
import Withdrawal from "../models/withdrawal_model.js";
import { creditUserBalance } from "./user-account.js";
import { deriveTronAccount, HOT_WALLET_INDEX, getTrxBalance, sendTrc20, toRawTrc20Amount, waitForConfirmation } from "./tron-wallet.js";

const USDT_CONTRACT_ADDRESS = process.env.USDT_CONTRACT_ADDRESS || "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
// Below this, the hot wallet can't reliably cover the energy/bandwidth cost of a TRC20 transfer —
// same threshold used on the sweep side (lib/deposit-sweep.js) for consistency.
const HOT_WALLET_TRX_MIN_THRESHOLD = Number(process.env.SWEEP_TRX_MIN_THRESHOLD || 15);

// Only ever picks up "pending" withdrawals — deliberately does NOT resume rows stuck in
// "processing" from a previous crashed run. Unlike the sweep side (where a redundant TRX top-up
// is harmless dust), blindly retrying a "processing" withdrawal risks a genuine double-send of
// real USDT to the user's external address if the previous run's broadcast actually succeeded
// before it crashed. A "processing" row that never resolves needs a human to check the chain and
// decide, not an automatic retry.
async function processWithdrawal(hotWallet, withdrawal, log) {
  await Withdrawal.updateOne({ _id: withdrawal._id }, { $set: { status: "processing" } });
  log(`[PROCESSING] id=${withdrawal._id} userId=${withdrawal.userId} amount=${withdrawal.amount} to=${withdrawal.toAddress}`);

  try {
    const rawAmount = await toRawTrc20Amount(withdrawal.amount, USDT_CONTRACT_ADDRESS);
    const txid = await sendTrc20(hotWallet.privateKey, withdrawal.toAddress, USDT_CONTRACT_ADDRESS, rawAmount);
    await waitForConfirmation(txid, { requireContractSuccess: true });

    await Withdrawal.updateOne(
      { _id: withdrawal._id },
      { $set: { status: "completed", txid, processedAt: new Date() } }
    );
    log(`[COMPLETED] id=${withdrawal._id} txid=${txid}`);
    return { id: withdrawal._id, status: "completed", txid };
  } catch (error) {
    // Failure after the balance was already debited at request time — refund it so the user never
    // loses money on a withdrawal that didn't actually go out. Marking "failed" and refunding
    // happen together in one transaction so they can't diverge (e.g. marked failed but refund lost
    // to a crash, or vice versa).
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await Withdrawal.updateOne(
          { _id: withdrawal._id },
          { $set: { status: "failed", processedAt: new Date() } },
          { session }
        );
        await creditUserBalance(
          withdrawal.userId,
          withdrawal.amount,
          `Refund for failed withdrawal ${withdrawal._id} (${error.message})`,
          session,
          { category: "withdrawal_refund" }
        );
      });
    } finally {
      await session.endSession();
    }
    log(`[FAILED] id=${withdrawal._id} error=${error.message} — balance refunded`);
    return { id: withdrawal._id, status: "failed", error: error.message };
  }
}

export async function runWithdrawalProcessing({ log = () => {} } = {}) {
  const hotWallet = deriveTronAccount(HOT_WALLET_INDEX);
  const hotWalletTrxBalance = await getTrxBalance(hotWallet.address);

  if (hotWalletTrxBalance < HOT_WALLET_TRX_MIN_THRESHOLD) {
    log(`[ALERT] Hot wallet TRX balance (${hotWalletTrxBalance}) is below ${HOT_WALLET_TRX_MIN_THRESHOLD} — skipping this run, top up ${hotWallet.address} before withdrawals can process.`);
    return { skipped: true, reason: "insufficient_hot_wallet_trx", hotWalletTrxBalance };
  }

  const pending = await Withdrawal.find({ status: "pending" });
  log(`Processing ${pending.length} pending withdrawal(s) from hot wallet ${hotWallet.address}...`);

  const results = [];
  for (const withdrawal of pending) {
    results.push(await processWithdrawal(hotWallet, withdrawal, log));
  }

  return {
    hotWallet: hotWallet.address,
    checked: pending.length,
    completed: results.filter((r) => r.status === "completed").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  };
}
