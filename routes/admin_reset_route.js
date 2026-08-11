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

// TEMPORARY — one-off verification endpoint, added to zero out a single user's real balance
// (accumulated via the old mock /api/deposit "Add" button, confirmed by the user) before they
// start testing real TRON deposits/withdrawals with a clean base. Will be reverted right after use,
// same pattern as every other one-off verification endpoint in this module.
adminResetRouter.post("/admin/reset-user-real-balance", async (req, res) => {
  try {
    const { clerkId, adminCode, targetClerkId } = req.body;
    if (!isAdmin(clerkId, adminCode)) {
      return res.status(403).json({ success: false, error: "Only the triomac60 administrator or a valid admin code can do this" });
    }
    if (!targetClerkId) {
      return res.status(400).json({ success: false, error: "Missing targetClerkId" });
    }

    const Users = getUsersCollection();
    const user = await Users.findOne({ clerkId: targetClerkId });
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const account = normalizeAccount(user.accounts?.real, 0);
    const balanceBefore = account.balance;
    const transaction = {
      type: "debit",
      category: "admin_reset",
      amount: balanceBefore,
      balanceBefore,
      balanceAfter: 0,
      description: "Balance reset before real TRON testing",
      createdAt: new Date(),
    };

    await Users.updateOne(
      { clerkId: targetClerkId },
      {
        $set: { "accounts.real.balance": 0, "wallet.balance": 0 },
        $push: { "accounts.real.transactions": transaction, "wallet.transactions": transaction },
      }
    );

    return res.status(200).json({ success: true, targetClerkId, balanceBefore, balanceAfter: 0 });
  } catch (error) {
    console.error("Reset user real balance error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

export default adminResetRouter;
