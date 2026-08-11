import express from "express";
import mongoose from "mongoose";
import DepositAddress from "../models/deposit_address_model.js";
import Deposit from "../models/deposit_model.js";
import { deriveTronAccount } from "../lib/tron-wallet.js";
import { getNextDerivationIndex } from "../lib/deposit-index-service.js";
import { isAdmin } from "../lib/admin.js";
import { getUsersCollection } from "../lib/user-account.js";

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

// TEMPORARY — diagnostic endpoint to figure out why a just-confirmed deposit credit isn't showing
// up in the user's balance/transaction history. Read-only, will be reverted right after use.
walletDepositRouter.post("/admin/debug-deposit-state", async (req, res) => {
  try {
    const { clerkId, adminCode, targetClerkId, txid } = req.body;
    if (!isAdmin(clerkId, adminCode)) {
      return res.status(403).json({ success: false, error: "Only the triomac60 administrator or a valid admin code can do this" });
    }

    const deposits = await Deposit.find({ userId: targetClerkId }).lean();
    const depositByTxid = txid ? await Deposit.findOne({ txid }).lean() : null;

    const Users = getUsersCollection();
    const user = await Users.findOne({ clerkId: targetClerkId });

    return res.status(200).json({
      success: true,
      mongooseReadyState: mongoose.connection.readyState,
      depositsForUser: deposits,
      depositByTxid,
      userAccountsReal: user?.accounts?.real
        ? { balance: user.accounts.real.balance, transactionCount: user.accounts.real.transactions?.length }
        : null,
      userWallet: user?.wallet ? { balance: user.wallet.balance, transactionCount: user.wallet.transactions?.length } : null,
    });
  } catch (error) {
    console.error("Debug deposit state error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

export default walletDepositRouter;
