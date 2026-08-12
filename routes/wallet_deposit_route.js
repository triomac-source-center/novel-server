import express from "express";
import DepositAddress from "../models/deposit_address_model.js";
import Deposit from "../models/deposit_model.js";
import { deriveTronAccount, getTrc20RawBalance, getTrxBalance } from "../lib/tron-wallet.js";
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

// TEMPORARY — read-only diagnostic to inspect Deposit records for the stuck address before
// reconciling the missed sweep confirmation. Will be reverted right after use.
walletDepositRouter.get("/admin/debug-deposits", async (req, res) => {
  const { address, userId } = req.query;
  const filter = {};
  if (address) filter.address = address;
  if (userId) filter.userId = userId;
  const deposits = await Deposit.find(filter).lean();
  return res.status(200).json({ count: deposits.length, deposits });
});

// TEMPORARY — read-only diagnostic: current on-chain USDT/TRX balance of a given address, using
// the same tested helpers sweepAddress relies on. Will be reverted right after use.
walletDepositRouter.get("/admin/debug-balance", async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ success: false, error: "Missing address" });
  const USDT_CONTRACT_ADDRESS = process.env.USDT_CONTRACT_ADDRESS || "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
  const [usdtRaw, trx] = await Promise.all([getTrc20RawBalance(address, USDT_CONTRACT_ADDRESS), getTrxBalance(address)]);
  return res.status(200).json({ address, usdtRaw, usdt: Number(usdtRaw) / 1e6, trx });
});

export default walletDepositRouter;
