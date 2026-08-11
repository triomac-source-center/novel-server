import express from "express";
import DepositAddress from "../models/deposit_address_model.js";
import { deriveTronAccount } from "../lib/tron-wallet.js";
import { getNextDerivationIndex } from "../lib/deposit-index-service.js";
import { requireAdminAccess } from "../lib/admin.js";

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

// TEMPORARY — read-only diagnostic (no state change) to re-confirm req.ip after the trust-proxy
// fix. Will be reverted right after use.
walletDepositRouter.get("/admin/debug-ip", (req, res) => {
  res.status(200).json({
    reqIp: req.ip,
    reqIps: req.ips,
    socketRemoteAddress: req.socket?.remoteAddress,
    xForwardedFor: req.get("x-forwarded-for"),
  });
});

// TEMPORARY — harmless admin-gated diagnostic (GET, no side effects at all — does NOT touch any
// data) so the rate limiter's lockout behavior can be exercised safely, without going anywhere
// near a real destructive endpoint. Will be reverted right after use.
walletDepositRouter.get("/admin/debug-access", requireAdminAccess, (req, res) => {
  res.status(200).json({ authorized: true });
});

export default walletDepositRouter;
