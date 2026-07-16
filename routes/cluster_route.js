import express from "express";
import mongoose from "mongoose";
import clus from "../models/cluster_model.js";
import { notify } from "../lib/notify.js";

const clusterRouter = express.Router();

const getUsersCollection = () => mongoose.connection.collection("users");

function generateSignature() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let signature = "";
  for (let i = 0; i < 15; i++) {
    signature += chars[Math.floor(Math.random() * chars.length)];
  }
  return signature;
}

// Create a real cluster
clusterRouter.post("/clusters", async (req, res) => {
  try {
    const {
      clerkId,
      symbol,
      name,
      description,
      algorythm,
      cellCount,
      cellValue,
    } = req.body;

    if (!clerkId) {
      return res.status(400).json({ success: false, error: "Missing clerkId" });
    }
    if (!symbol || !algorythm) {
      return res.status(400).json({ success: false, error: "Missing symbol or algorythm" });
    }

    const parsedCellCount = Number(cellCount);
    const parsedCellValue = Number(cellValue);

    if (!Number.isFinite(parsedCellCount) || parsedCellCount <= 0) {
      return res.status(400).json({ success: false, error: "Invalid cell count" });
    }
    if (!Number.isFinite(parsedCellValue) || parsedCellValue <= 0) {
      return res.status(400).json({ success: false, error: "Invalid cell value" });
    }

    const data = {
      holderPoint: 0,
      entryPoint: parsedCellValue,
      holders: [],
      expVolume: parsedCellCount,
      actualVolume: 0,
      holderRemain: parsedCellCount,
      creator: clerkId,
      status: "offline",
      symbol: symbol.trim(),
      name: name?.trim() || symbol.trim(),
      description: description?.trim() || "",
      recette: 0,
      algorythm: algorythm.trim(),
      signature: generateSignature(),
    };

    const cluster = await clus.create(data);

    await notify({
      clerkId,
      type: "cluster_created",
      title: "Cluster created",
      message: `Your cluster ${cluster.symbol} is live and open for investors.`,
      relatedId: String(cluster._id),
    });

    return res.status(201).json({
      success: true,
      data: cluster,
    });
  } catch (error) {
    console.error("Create cluster error:", error);
    return res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// Invest cells into an existing cluster
clusterRouter.post("/clusters/:id/invest", async (req, res) => {
  try {
    const { id } = req.params;
    const { clerkId, cells } = req.body;

    if (!clerkId) {
      return res.status(400).json({ success: false, error: "Missing clerkId" });
    }

    const parsedCells = Number(cells);
    if (!Number.isFinite(parsedCells) || parsedCells <= 0 || !Number.isInteger(parsedCells)) {
      return res.status(400).json({ success: false, error: "Invalid cell count" });
    }

    const cluster = await clus.findById(id);
    if (!cluster) {
      return res.status(404).json({ success: false, error: "Cluster not found" });
    }

    if (cluster.status === "closed") {
      return res.status(400).json({ success: false, error: "Cluster is already closed" });
    }

    if (parsedCells > cluster.holderRemain) {
      return res.status(400).json({
        success: false,
        error: `Only ${cluster.holderRemain} cell(s) remaining in this cluster`,
      });
    }

    const amount = parsedCells * cluster.entryPoint;

    const Users = getUsersCollection();
    const user = await Users.findOne({ clerkId });

    if (!user) {
      return res.status(404).json({ success: false, error: "User account not found" });
    }

    const realAccount = user.accounts?.real || { balance: user.wallet?.balance ?? 0, transactions: [] };
    const currentBalance = Number(realAccount.balance ?? 0);

    if (currentBalance < amount) {
      return res.status(400).json({ success: false, error: "Insufficient real account balance" });
    }

    const balanceAfter = currentBalance - amount;

    const transaction = {
      type: "debit",
      amount,
      balanceBefore: currentBalance,
      balanceAfter,
      description: `Invested ${parsedCells} cell(s) in cluster ${cluster.symbol}`,
      createdAt: new Date(),
    };

    const nextAccounts = {
      ...(user.accounts || {}),
      real: {
        ...realAccount,
        balance: balanceAfter,
        transactions: [...(realAccount.transactions || []), transaction],
        updatedAt: new Date(),
      },
    };

    await Users.findOneAndUpdate(
      { clerkId },
      {
        $set: {
          accounts: nextAccounts,
          "wallet.balance": balanceAfter,
          "wallet.transactions": [...((user.wallet?.transactions || [])), transaction],
        },
      }
    );

    cluster.holders.push({ clerkId, cells: parsedCells, amount });
    cluster.holderPoint += parsedCells;
    cluster.actualVolume += amount;
    cluster.holderRemain -= parsedCells;
    cluster.recette = cluster.actualVolume * 0.16;

    const justClosed = cluster.holderRemain === 0 && cluster.status !== "closed";
    if (justClosed) {
      cluster.status = "closed";
      cluster.closedAt = new Date();
    } else if (cluster.status === "offline") {
      cluster.status = "online";
    }

    await cluster.save();

    await notify({
      clerkId,
      type: "invest",
      title: "Investment confirmed",
      message: `You invested $${amount.toLocaleString()} (${parsedCells} cell${parsedCells > 1 ? "s" : ""}) in cluster ${cluster.symbol}.`,
      relatedId: String(cluster._id),
    });

    if (justClosed) {
      await notify({
        clerkId: cluster.creator,
        type: "cluster_filled",
        title: "Cluster fully funded",
        message: `Your cluster ${cluster.symbol} has reached its target and is now closed.`,
        relatedId: String(cluster._id),
      });
    }

    return res.status(200).json({
      success: true,
      data: cluster,
      wallet: { balance: balanceAfter },
    });
  } catch (error) {
    console.error("Invest in cluster error:", error);
    return res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

export default clusterRouter;
