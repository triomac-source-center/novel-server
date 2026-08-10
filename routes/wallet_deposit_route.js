import express from "express";
import DepositAddress from "../models/deposit_address_model.js";
import Deposit from "../models/deposit_model.js";
import { deriveTronAccount } from "../lib/tron-wallet.js";
import { getNextDerivationIndex } from "../lib/deposit-index-service.js";
import { runDepositDetection } from "../lib/deposit-detection.js";
import { isAdmin } from "../lib/admin.js";

const walletDepositRouter = express.Router();

// TEMPORARY — admin-gated read-only listing, to inspect what's actually in the database instead
// of relying on conversational memory of which test address was used for what. Removed again
// right after use.
walletDepositRouter.get("/admin/deposit-debug", async (req, res) => {
  try {
    const { adminCode } = req.query;
    if (!isAdmin(null, adminCode)) {
      return res.status(403).json({ success: false, error: "Invalid admin code" });
    }
    const [addresses, deposits] = await Promise.all([DepositAddress.find({}), Deposit.find({})]);
    return res.status(200).json({ success: true, data: { addresses, deposits } });
  } catch (error) {
    console.error("Deposit debug error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// TEMPORARY — admin-gated trigger to verify detect-deposits.js end-to-end against a real testnet
// transfer without needing shell access to the running server. Will be removed again once
// confirmed working (not meant to stay as a permanent endpoint).
walletDepositRouter.post("/admin/run-deposit-detection", async (req, res) => {
  try {
    const { clerkId, adminCode } = req.body;
    if (!isAdmin(clerkId, adminCode)) {
      return res.status(403).json({ success: false, error: "Only the triomac60 administrator or a valid admin code can trigger deposit detection" });
    }
    const result = await runDepositDetection();
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("Run deposit detection error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
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
