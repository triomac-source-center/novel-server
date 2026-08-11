import express from "express";
import DepositAddress from "../models/deposit_address_model.js";
import { deriveTronAccount } from "../lib/tron-wallet.js";
import { getNextDerivationIndex } from "../lib/deposit-index-service.js";
import { runWithdrawalProcessing } from "../lib/withdrawal-processing.js";
import Withdrawal from "../models/withdrawal_model.js";
import { isAdmin } from "../lib/admin.js";

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

// TEMPORARY — one-off trigger to run process-withdrawals.js against production (no shell/SSH
// access to Render). Will be reverted in a following commit right after use, same pattern as every
// previous one-off verification endpoint in this module.
walletDepositRouter.post("/admin/run-withdrawal-processing", async (req, res) => {
  try {
    const { clerkId, adminCode } = req.body;
    if (!isAdmin(clerkId, adminCode)) {
      return res.status(403).json({ success: false, error: "Only the triomac60 administrator or a valid admin code can do this" });
    }
    const lines = [];
    const result = await runWithdrawalProcessing({ log: (line) => lines.push(line) });
    return res.status(200).json({ success: true, result, log: lines });
  } catch (error) {
    console.error("Run withdrawal processing error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

// TEMPORARY — diagnostic: list Withdrawal records for a user, since run-withdrawal-processing
// found 0 pending rows but the user sees a pending 50 USDT withdrawal on the Wallet page. Will be
// reverted right after use.
walletDepositRouter.post("/admin/list-withdrawals", async (req, res) => {
  try {
    const { clerkId, adminCode, targetClerkId } = req.body;
    if (!isAdmin(clerkId, adminCode)) {
      return res.status(403).json({ success: false, error: "Only the triomac60 administrator or a valid admin code can do this" });
    }
    const withdrawals = await Withdrawal.find(targetClerkId ? { userId: targetClerkId } : {}).sort({ requestedAt: -1 }).lean();
    return res.status(200).json({ success: true, withdrawals });
  } catch (error) {
    console.error("List withdrawals error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

export default walletDepositRouter;
