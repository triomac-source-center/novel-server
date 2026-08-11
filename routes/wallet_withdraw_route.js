import express from "express";
import mongoose from "mongoose";
import { getAuth } from "@clerk/express";
import Withdrawal from "../models/withdrawal_model.js";
import { debitUserBalance } from "../lib/user-account.js";
import { isValidTronAddress } from "../lib/tron-wallet.js";
import { requireAuthJson } from "../lib/require-auth-json.js";

const WITHDRAWAL_MANUAL_REVIEW_THRESHOLD = Number(process.env.WITHDRAWAL_MANUAL_REVIEW_THRESHOLD || 500);

const walletWithdrawRouter = express.Router();

// This route moves money OUT to an address the caller supplies, so it requires a real verified
// Clerk session (clerkMiddleware() is mounted globally in app.js, requireAuthJson below is what
// actually enforces it on this specific route).
walletWithdrawRouter.post("/wallet/withdraw", requireAuthJson, async (req, res) => {
  try {
    const { userId: clerkId } = getAuth(req);
    const { amount, toAddress } = req.body;

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ success: false, error: "Invalid amount" });
    }
    if (!isValidTronAddress(toAddress)) {
      return res.status(400).json({ success: false, error: "Invalid TRON address" });
    }

    const status = numericAmount > WITHDRAWAL_MANUAL_REVIEW_THRESHOLD ? "pending_review" : "pending";

    const session = await mongoose.startSession();
    let withdrawal;
    try {
      await session.withTransaction(async () => {
        // Debited immediately (atomic $gte/$inc check inside debitUserBalance) — the balance is
        // committed the moment the request is accepted, before any blockchain broadcast happens.
        // This is deliberate: process-withdrawals.js is a separate, later step (like deposit
        // detection/sweep), and the user's available balance must reflect the commitment right away
        // so they can't withdraw the same funds twice while the first request is still in flight.
        await debitUserBalance(clerkId, numericAmount, `Withdrawal request to ${toAddress}`, session);
        const created = await Withdrawal.create(
          [{ userId: clerkId, toAddress, amount: numericAmount, status }],
          { session }
        );
        withdrawal = created[0];
      });
    } finally {
      await session.endSession();
    }

    return res.status(201).json({
      success: true,
      data: { id: withdrawal._id, status: withdrawal.status, amount: withdrawal.amount, toAddress: withdrawal.toAddress },
    });
  } catch (error) {
    if (error.message === "Insufficient balance") {
      return res.status(400).json({ success: false, error: "Insufficient balance" });
    }
    console.error("Withdrawal request error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

export default walletWithdrawRouter;
