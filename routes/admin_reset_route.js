import express from "express";
import clus from "../models/cluster_model.js";
import AuthorshipBlock from "../models/authorship_block_model.js";
import { requireAdminAccess } from "../lib/admin.js";
import { getUsersCollection, getDefaultAccounts } from "../lib/user-account.js";

const adminResetRouter = express.Router();

// Nuclear option for wiping test data clean: every cluster, every authorship block, AND every
// user's wallet (both real and demo balances + full transaction history) reset to zero, so the
// whole system — including account balances — genuinely starts from scratch and everyone has to
// deposit again. Distinct from DELETE /clusters (which only clears clusters/blocks, not wallets).
adminResetRouter.delete("/admin/reset-all", requireAdminAccess, async (req, res) => {
  try {
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

export default adminResetRouter;
