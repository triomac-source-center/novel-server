import express from "express";
import DepositAddress from "../models/deposit_address_model.js";
import { deriveTronAccount } from "../lib/tron-wallet.js";
import { getNextDerivationIndex } from "../lib/deposit-index-service.js";
import { ensureUserRecord, debugCounters } from "../lib/user-account.js";
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

// TEMPORARY — proves the ensureUserRecord race fix: calls it N times rapidly for a normal,
// already-valid account and reports how many of those calls actually reached the $set write path
// (via the debugCounters instrumentation added alongside it). Will be reverted together.
walletDepositRouter.post("/admin/test-ensure-user-record", async (req, res) => {
  try {
    const { clerkId, adminCode, targetClerkId, iterations = 10 } = req.body;
    if (!isAdmin(clerkId, adminCode)) {
      return res.status(403).json({ success: false, error: "Only the triomac60 administrator or a valid admin code can do this" });
    }
    if (!targetClerkId) {
      return res.status(400).json({ success: false, error: "Missing targetClerkId" });
    }

    const before = debugCounters.ensureUserRecordWrites;
    const results = [];
    for (let i = 0; i < iterations; i += 1) {
      const user = await ensureUserRecord(targetClerkId);
      results.push({ balance: user.accounts?.real?.balance, transactionCount: user.accounts?.real?.transactions?.length });
    }
    const after = debugCounters.ensureUserRecordWrites;

    return res.status(200).json({
      success: true,
      iterations,
      writesTriggered: after - before,
      resultsConsistent: results.every((r) => r.balance === results[0].balance && r.transactionCount === results[0].transactionCount),
      results,
    });
  } catch (error) {
    console.error("Test ensureUserRecord error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

export default walletDepositRouter;
