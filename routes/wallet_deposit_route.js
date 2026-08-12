import express from "express";
import mongoose from "mongoose";
import DepositAddress from "../models/deposit_address_model.js";
import Deposit from "../models/deposit_model.js";
import { deriveTronAccount } from "../lib/tron-wallet.js";
import { getNextDerivationIndex } from "../lib/deposit-index-service.js";
import { getUsersCollection, normalizeAccount } from "../lib/user-account.js";

const walletDepositRouter = express.Router();

// GET /api/wallet/deposit-address?clerkId=... — same "trust the clerkId passed in the request"
// convention used by every other route in this backend (no server-side Clerk token verification
// exists anywhere here yet).
walletDepositRouter.get("/wallet/deposit-address", async (req, res) => {
  try {
    const { clerkId } = req.query;
    if (!clerkId) {
      return res.status(400).json({ success: false, error: "Missing clerkId" });
    }

    const existing = await DepositAddress.findOne({ userId: clerkId });
    if (existing) {
      return res.status(200).json({
        success: true,
        data: { address: existing.address, derivationIndex: existing.derivationIndex },
      });
    }

    const index = await getNextDerivationIndex();
    const { address } = deriveTronAccount(index);
    const created = await DepositAddress.create({ userId: clerkId, derivationIndex: index, address });

    return res.status(201).json({
      success: true,
      data: { address: created.address, derivationIndex: created.derivationIndex },
    });
  } catch (error) {
    console.error("Deposit address error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// TEMPORARY — one-off reconciliation: (1) marks the 7f271cf1... Deposit as swept with its
// confirmed-on-chain txid (missed by waitForConfirmation's timeout, before today's fix), and
// (2) reverses the resulting 50 USDT double-credit on user_3HVugK55U27lJFrKx8GFeTYXPAD (that
// Deposit was a re-detected echo of an earlier withdrawal, before today's internal-address
// filter fix). Both actions confirmed explicitly by the user. Will be reverted right after use.
walletDepositRouter.post("/admin/reconcile-sweep-and-double-credit", async (req, res) => {
  const DEPOSIT_TXID = "7f271cf1daedf77dfd4bab1929ab30a554362966cc977cb5ee652de4b0316b80";
  const SWEEP_TXID = "888ffd5da82eab7de61c9444eb9e529c0f87822bcb4ba86fc2034b2e212f26de";
  const TARGET_CLERK_ID = "user_3HVugK55U27lJFrKx8GFeTYXPAD";
  const REVERSAL_AMOUNT = 50;

  const depositUpdate = await Deposit.findOneAndUpdate(
    { txid: DEPOSIT_TXID },
    { $set: { sweepStatus: "swept", sweepTxid: SWEEP_TXID } },
    { new: true }
  );

  const Users = getUsersCollection();
  const user = await Users.findOne({ clerkId: TARGET_CLERK_ID });
  if (!user) return res.status(404).json({ success: false, error: "User not found" });

  const account = normalizeAccount(user.accounts?.real, 0);
  const balanceBefore = account.balance;
  const balanceAfter = balanceBefore - REVERSAL_AMOUNT;
  const transaction = {
    type: "debit",
    category: "correction",
    amount: REVERSAL_AMOUNT,
    balanceBefore,
    balanceAfter,
    description: `Reversal of duplicate deposit credit (txid ${DEPOSIT_TXID} was a re-detected echo of an earlier withdrawal to the same tracked address, not a genuine external deposit — see internal-address filter fix)`,
    createdAt: new Date(),
  };

  await Users.updateOne(
    { clerkId: TARGET_CLERK_ID },
    {
      $set: { "accounts.real.balance": balanceAfter, "wallet.balance": balanceAfter },
      $push: { "accounts.real.transactions": transaction, "wallet.transactions": transaction },
    }
  );

  return res.status(200).json({
    success: true,
    depositUpdated: Boolean(depositUpdate),
    depositSweepStatus: depositUpdate?.sweepStatus ?? null,
    balanceBefore,
    balanceAfter,
  });
});

export default walletDepositRouter;
