import express from "express";
import DepositAddress from "../models/deposit_address_model.js";
import Deposit from "../models/deposit_model.js";
import { deriveTronAccount } from "../lib/tron-wallet.js";
import { getNextDerivationIndex } from "../lib/deposit-index-service.js";

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

// TEMPORARY — read-only diagnostic to inspect the exact Deposit records for test_cron_final,
// investigating why sweep-deposits.js found 0 addresses right after detect-deposits.js credited 2
// deposits. Will be reverted right after use.
walletDepositRouter.get("/admin/debug-deposits", async (req, res) => {
  const { userId } = req.query;
  const deposits = await Deposit.find(userId ? { userId } : {}).lean();
  return res.status(200).json({ count: deposits.length, deposits });
});

export default walletDepositRouter;
