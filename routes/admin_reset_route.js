import express from "express";
import clus from "../models/cluster_model.js";
import AuthorshipBlock from "../models/authorship_block_model.js";
import { isAdmin } from "../lib/admin.js";
import { getUsersCollection, getDefaultAccounts, normalizeAccount } from "../lib/user-account.js";

const adminResetRouter = express.Router();

// Nuclear option for wiping test data clean: every cluster, every authorship block, AND every
// user's wallet (both real and demo balances + full transaction history) reset to zero, so the
// whole system — including account balances — genuinely starts from scratch and everyone has to
// deposit again. Distinct from DELETE /clusters (which only clears clusters/blocks, not wallets).
adminResetRouter.delete("/admin/reset-all", async (req, res) => {
  try {
    const { clerkId, adminCode } = req.body;
    if (!isAdmin(clerkId, adminCode)) {
      return res.status(403).json({ success: false, error: "Only the triomac60 administrator or a valid admin code can reset all data" });
    }

    const clusterResult = await clus.deleteMany({});
    const blockResult = await AuthorshipBlock.deleteMany({});
    const Users = getUsersCollection();
    const userResult = await Users.updateMany(
      {},
      { $set: { accounts: getDefaultAccounts(), "wallet.balance": 0, "wallet.transactions": [] } }
    );

    return res.status(200).json({
      success: true,
      deletedClusters: clusterResult.deletedCount,
      deletedBlocks: blockResult.deletedCount,
      resetUsers: userResult.modifiedCount,
    });
  } catch (error) {
    console.error("Reset all error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

// TEMPORARY — one-off recovery credit for a confirmed on-chain deposit whose internal balance
// update was lost to the ensureUserRecord race (now fixed). Will be reverted right after use.
adminResetRouter.post("/admin/recover-deposit-credit", async (req, res) => {
  try {
    const { clerkId, adminCode, targetClerkId, amount, description } = req.body;
    if (!isAdmin(clerkId, adminCode)) {
      return res.status(403).json({ success: false, error: "Only the triomac60 administrator or a valid admin code can do this" });
    }
    if (!targetClerkId || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: "Missing targetClerkId or invalid amount" });
    }

    const Users = getUsersCollection();
    const user = await Users.findOne({ clerkId: targetClerkId });
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const numericAmount = Number(amount);
    const account = normalizeAccount(user.accounts?.real, 0);
    const balanceBefore = account.balance;
    const balanceAfter = balanceBefore + numericAmount;
    const transaction = {
      type: "credit",
      category: "deposit_recovery",
      amount: numericAmount,
      balanceBefore,
      balanceAfter,
      description: description || "Deposit recovery credit",
      createdAt: new Date(),
    };

    await Users.updateOne(
      { clerkId: targetClerkId },
      {
        $set: { "accounts.real.balance": balanceAfter, "wallet.balance": balanceAfter },
        $push: { "accounts.real.transactions": transaction, "wallet.transactions": transaction },
      }
    );

    return res.status(200).json({ success: true, targetClerkId, balanceBefore, balanceAfter });
  } catch (error) {
    console.error("Recover deposit credit error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

export default adminResetRouter;
