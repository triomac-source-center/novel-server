import express from "express";
import mongoose from "mongoose";
import { requireAuth, getAuth } from "@clerk/express";
import AuthorshipBlock from "../models/authorship_block_model.js";
import clus from "../models/cluster_model.js";
import { notify } from "../lib/notify.js";
import { broadcastBalanceUpdate } from "../lib/sse.js";
import { ensureUserRecord, getUsersCollection } from "../lib/user-account.js";
import { computeCommittedFunds } from "../lib/available-funds.js";

const blockRouter = express.Router();

function accountFor(user) {
  return user.accounts?.real || { balance: user.wallet?.balance ?? 0, currency: "USD", transactions: [] };
}

async function writeAccount(Users, clerkId, user, account, transaction, session) {
  const accounts = { ...(user.accounts || {}), real: { ...account, transactions: [...(account.transactions || []), transaction], updatedAt: new Date() } };
  await Users.findOneAndUpdate(
    { clerkId },
    { $set: { accounts, "wallet.balance": account.balance, "wallet.transactions": [...(user.wallet?.transactions || []), transaction] } },
    { session }
  );
}

async function creditOwner(Users, clerkId, amount, description, session, meta = {}) {
  const user = await Users.findOne({ clerkId }, { session });
  if (!user) throw new Error(`Block owner ${clerkId} no longer has an account`);
  const account = accountFor(user);
  const before = Number(account.balance || 0);
  account.balance = before + amount;
  await writeAccount(
    Users,
    clerkId,
    user,
    account,
    {
      type: "credit",
      category: "block",
      amount,
      balanceBefore: before,
      balanceAfter: account.balance,
      description,
      clusterId: meta.clusterId ?? null,
      clusterSymbol: meta.clusterSymbol ?? null,
      layer: meta.layer ?? null,
      createdAt: new Date(),
    },
    session
  );
  broadcastBalanceUpdate(String(clerkId), { balance: account.balance, accountType: "real" });
}

// Public marketplace listing: only blocks belonging to published (online/closed) clusters are
// visible, same rule as "when a cluster becomes public, its blocks become public too". Admin
// callers pass ?all=true to see blocks for draft clusters as well.
blockRouter.get("/blocks", async (req, res) => {
  try {
    const { status, clusterId, ownerClerkId, all } = req.query;
    const filter = {};

    if (all !== "true") {
      const publishedClusters = await clus.find({ status: { $ne: "offline" } }, { _id: 1 });
      filter.clusterId = { $in: publishedClusters.map((c) => c._id) };
    }
    if (clusterId) filter.clusterId = clusterId;
    if (status && status !== "all") filter.status = status;
    if (ownerClerkId) filter.ownerClerkId = ownerClerkId;

    const blocks = await AuthorshipBlock.find(filter).sort({ clusterId: 1, layer: 1 });
    return res.status(200).json({ success: true, count: blocks.length, data: blocks });
  } catch (error) {
    console.error("List blocks error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

blockRouter.get("/blocks/:id", async (req, res) => {
  try {
    const block = await AuthorshipBlock.findById(req.params.id);
    if (!block) return res.status(404).json({ success: false, error: "Block not found" });
    return res.status(200).json({ success: true, data: block });
  } catch (error) {
    console.error("Get block error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Buys one or more blocks in a single transaction (spec 6.1). Each block is either an initial
// sale (status "available", money goes to the system/cluster's systemReserve) or a resale
// (status "sold" + listedForResale, money goes peer-to-peer to the current owner, no system cut).
blockRouter.post("/blocks/buy", requireAuth(), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { userId: clerkId } = getAuth(req);
    const { blockIds } = req.body;
    if (!Array.isArray(blockIds) || blockIds.length === 0) {
      return res.status(400).json({ success: false, error: "At least one block id is required" });
    }
    await ensureUserRecord(String(clerkId));
    let response;
    await session.withTransaction(async () => {
      const Users = getUsersCollection();
      const buyer = await Users.findOne({ clerkId }, { session });
      if (!buyer) throw new Error("Buyer account not found");
      const buyerAccount = accountFor(buyer);
      const balanceBefore = Number(buyerAccount.balance || 0);
      // MT5-style: Balance is untouched by a purchase. Affordability is checked against available
      // funds (balance minus everything already committed to currently-open positions), decremented
      // locally as this loop "spends" more within the same multi-block purchase.
      const committed = await computeCommittedFunds(clerkId, session);
      let remainingAvailable = balanceBefore - committed;
      let totalSpent = 0;
      const purchased = [];

      for (const blockId of blockIds) {
        const block = await AuthorshipBlock.findById(blockId).session(session);
        if (!block) throw new Error(`Block ${blockId} not found`);
        const isInitialSale = block.status === "available";
        const isResale = block.status === "sold" && block.listedForResale;
        if (!isInitialSale && !isResale) throw new Error(`Block for layer ${block.layer} of ${block.clusterSymbol} is not available for purchase`);
        if (isResale && block.ownerClerkId === clerkId) throw new Error("You already own this block");

        const price = isInitialSale ? block.originalPrice : Number(block.resalePrice);
        if (remainingAvailable < price) throw new Error("Insufficient available funds (balance minus your currently open positions).");
        remainingAvailable -= price;
        totalSpent += price;

        if (isInitialSale) {
          const cluster = await clus.findById(block.clusterId).session(session);
          if (cluster) {
            cluster.systemReserve = Number(cluster.systemReserve || 0) + price;
            cluster.recette = cluster.systemReserve;
            cluster.activityLog.push({ type: "block_sale", clerkId, amount: price, layer: block.layer, createdAt: new Date() });
            await cluster.save({ session });
          }
        } else {
          await creditOwner(Users, block.ownerClerkId, price, `Authorship block resold: ${block.clusterSymbol} layer ${block.layer}`, session, {
            clusterId: String(block.clusterId),
            clusterSymbol: block.clusterSymbol,
            layer: block.layer,
          });
        }

        const at = new Date();
        for (const entry of block.ownershipHistory) {
          if (!entry.releasedAt) entry.releasedAt = at;
        }
        block.ownershipHistory.push({ clerkId, price, acquiredAt: at, releasedAt: null });
        block.ownerClerkId = clerkId;
        block.status = "sold";
        block.listedForResale = false;
        block.resalePrice = null;
        await block.save({ session });
        purchased.push(block);
      }

      if (totalSpent > 0) {
        const debit = {
          type: "debit",
          category: "block",
          amount: totalSpent,
          balanceBefore,
          balanceAfter: balanceBefore,
          description: `Purchased ${purchased.length} authorship block(s)`,
          createdAt: new Date(),
        };
        await writeAccount(Users, clerkId, buyer, buyerAccount, debit, session);
      }
      response = { blocks: purchased, balance: balanceBefore };
    });

    await notify({
      clerkId,
      type: "block_purchase",
      title: "Authorship block(s) acquired",
      message: `You acquired ${response.blocks.length} authorship block(s).`,
    });
    return res.status(200).json({ success: true, data: response.blocks, wallet: { balance: response.balance } });
  } catch (error) {
    console.error("Buy block error:", error);
    return res.status(400).json({ success: false, error: error.message });
  } finally {
    await session.endSession();
  }
});

blockRouter.patch("/blocks/:id/list", async (req, res) => {
  try {
    const { clerkId, resalePrice } = req.body;
    const price = Number(resalePrice);
    if (!clerkId || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ success: false, error: "A valid owner and resale price are required" });
    }
    const block = await AuthorshipBlock.findById(req.params.id);
    if (!block) return res.status(404).json({ success: false, error: "Block not found" });
    if (block.ownerClerkId !== clerkId) return res.status(403).json({ success: false, error: "Only the current owner can list this block" });
    if (block.status !== "sold") return res.status(400).json({ success: false, error: "Only a currently-held block can be listed for resale" });
    block.listedForResale = true;
    block.resalePrice = price;
    await block.save();
    return res.status(200).json({ success: true, data: block });
  } catch (error) {
    console.error("List block error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

blockRouter.patch("/blocks/:id/unlist", async (req, res) => {
  try {
    const { clerkId } = req.body;
    const block = await AuthorshipBlock.findById(req.params.id);
    if (!block) return res.status(404).json({ success: false, error: "Block not found" });
    if (block.ownerClerkId !== clerkId) return res.status(403).json({ success: false, error: "Only the current owner can unlist this block" });
    block.listedForResale = false;
    block.resalePrice = null;
    await block.save();
    return res.status(200).json({ success: true, data: block });
  } catch (error) {
    console.error("Unlist block error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

export default blockRouter;
