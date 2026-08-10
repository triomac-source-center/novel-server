import express from "express";
import DepositAddress from "../models/deposit_address_model.js";
import { deriveTronAccount } from "../lib/tron-wallet.js";
import { getNextDerivationIndex } from "../lib/deposit-index-service.js";
import { isAdmin } from "../lib/admin.js";

const walletDepositRouter = express.Router();

// TEMPORARY — one-shot cleanup of test entries, admin-gated. Added to delete test_user_123/456,
// will be removed again right after use (not meant to stay as a permanent endpoint).
walletDepositRouter.delete("/wallet/deposit-address", async (req, res) => {
  const { clerkId, adminCode, targetClerkId } = req.body;
  if (!isAdmin(clerkId, adminCode)) {
    return res.status(403).json({ success: false, error: "Only the triomac60 administrator or a valid admin code can delete deposit addresses" });
  }
  if (!targetClerkId) return res.status(400).json({ success: false, error: "Missing targetClerkId" });
  const result = await DepositAddress.deleteOne({ userId: targetClerkId });
  return res.status(200).json({ success: true, deletedCount: result.deletedCount });
});

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

export default walletDepositRouter;
