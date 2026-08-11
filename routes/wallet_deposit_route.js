import express from "express";
import mongoose from "mongoose";
import DepositAddress from "../models/deposit_address_model.js";
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

// TEMPORARY — read-only diagnostic (no state change, no secrets exposed) to check whether MongoDB
// is actually reachable after the Doppler env restoration. Investigating a consistent ~10s 500 on
// GET /notifications, which looks exactly like Mongoose's default bufferTimeoutMS (10000ms) firing
// because queries are buffering against a connection that never finishes connecting. Will be
// reverted right after use.
walletDepositRouter.get("/admin/debug-mongo", async (req, res) => {
  const readyStateNames = ["disconnected", "connected", "connecting", "disconnecting"];
  const info = {
    readyState: mongoose.connection.readyState,
    readyStateName: readyStateNames[mongoose.connection.readyState] ?? "unknown",
    host: mongoose.connection.host ?? null,
    name: mongoose.connection.name ?? null,
    mongoUiSet: Boolean(process.env.MONGO_UI),
  };

  try {
    const pingResult = await Promise.race([
      mongoose.connection.db?.admin().ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("ping timed out after 5000ms")), 5000)),
    ]);
    info.ping = pingResult ? "ok" : "no db handle available";
  } catch (error) {
    info.ping = `failed: ${error.message}`;
  }

  return res.status(200).json(info);
});

export default walletDepositRouter;
