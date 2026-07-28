import express from "express";
import mongoose from "mongoose";
import clus from "../models/cluster_model.js";
import { notify } from "../lib/notify.js";
import { broadcastBalanceUpdate } from "../lib/sse.js";
import { ensureUserRecord } from "../lib/user-account.js";

const clusterRouter = express.Router();
const SYSTEM_NAME = "triomac60";
const SYSTEM_SHARE_RATE = 0.16;

const getUsersCollection = () => mongoose.connection.collection("users");

function generateSignature() {
  return Array.from({ length: 15 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 36)]).join("");
}

function cellPrice(cluster) {
  return Number(cluster.entryPoint) + (Number(cluster.currentLayer || 1) - 1) * Number(cluster.layerStep || 0);
}

const FALLBACK_ADMIN_CODE = "larson477";

function isAdmin(clerkId, adminCode) {
  const matchesClerkId = Boolean(process.env.TRIOMAC60_ADMIN_CLERK_ID) && clerkId === process.env.TRIOMAC60_ADMIN_CLERK_ID;
  const expectedCode = process.env.TRIOMAC60_ADMIN_CODE || FALLBACK_ADMIN_CODE;
  const matchesCode = Boolean(adminCode) && adminCode === expectedCode;
  return matchesClerkId || matchesCode;
}

function pushActivity(cluster, entry) {
  cluster.activityLog.push({ createdAt: new Date(), ...entry });
}

function ensureCells(cluster) {
  if (Array.isArray(cluster.cells) && cluster.cells.length === Number(cluster.expVolume)) return;
  const cells = [];
  for (const holder of cluster.holders || []) {
    for (let index = 0; index < Number(holder.cells || 0) && cells.length < Number(cluster.expVolume); index += 1) {
      cells.push({ number: cells.length + 1, ownerClerkId: holder.clerkId, acquiredLayer: Number(cluster.currentLayer || 1), acquiredPrice: Number(holder.amount || 0) / Math.max(Number(holder.cells || 1), 1), acquiredAt: holder.investedAt || new Date() });
    }
  }
  while (cells.length < Number(cluster.expVolume)) cells.push({ number: cells.length + 1, ownerClerkId: null, acquiredLayer: 0, acquiredPrice: 0, acquiredAt: null });
  cluster.cells = cells;
}

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
  if (!user) throw new Error(`Cell owner ${clerkId} no longer has an account`);
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
      category: "investment",
      amount,
      balanceBefore: before,
      balanceAfter: account.balance,
      description,
      clusterId: meta.clusterId ?? null,
      clusterSymbol: meta.clusterSymbol ?? null,
      layer: meta.layer ?? null,
      costBasis: meta.costBasis ?? 0,
      createdAt: new Date(),
    },
    session
  );
  broadcastBalanceUpdate(String(clerkId), { balance: account.balance, accountType: "real" });
}

clusterRouter.post("/clusters", async (req, res) => {
  try {
    const { clerkId, adminCode, symbol, name, description, algorythm, cellCount, cellValue, maxLayers = 1, layerStep = 0 } = req.body;
    if (!isAdmin(clerkId, adminCode)) return res.status(403).json({ success: false, error: "Only the triomac60 administrator or a valid admin code can create clusters" });
    const count = Number(cellCount), value = Number(cellValue), layers = Number(maxLayers), step = Number(layerStep);
    if (!symbol || !algorythm || !Number.isInteger(count) || count <= 0 || !Number.isFinite(value) || value <= 0 || !Number.isInteger(layers) || layers <= 0 || !Number.isFinite(step) || step < 0) return res.status(400).json({ success: false, error: "Invalid cluster configuration" });
    const cells = Array.from({ length: count }, (_, index) => ({ number: index + 1, ownerClerkId: null, acquiredLayer: 0, acquiredPrice: 0, acquiredAt: null }));
    const cluster = await clus.create({
      holderPoint: 0,
      entryPoint: value,
      holders: [],
      expVolume: count,
      actualVolume: 0,
      holderRemain: count,
      creator: SYSTEM_NAME,
      status: "offline",
      symbol: symbol.trim(),
      name: name?.trim() || symbol.trim(),
      description: description?.trim() || "",
      recette: 0,
      algorythm: algorythm.trim(),
      signature: generateSignature(),
      currentLayer: 1,
      maxLayers: layers,
      layerStep: step,
      cells,
      layerHistory: [{ layer: 1, pricePerCell: value, filledCells: 0 }],
      activityLog: [{ type: "created", clerkId, layer: 1, createdAt: new Date() }],
      systemShareRate: SYSTEM_SHARE_RATE,
      systemReserve: 0,
    });
    await notify({ clerkId, type: "cluster_created", title: "Cluster created (draft)", message: `${cluster.symbol} was created as a draft. Publish it to open it for investment.`, relatedId: String(cluster._id) });
    return res.status(201).json({ success: true, data: cluster });
  } catch (error) {
    console.error("Create cluster error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

clusterRouter.post("/clusters/:id/invest", async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { clerkId, cells } = req.body;
    const quantity = Number(cells);
    if (!clerkId || !Number.isInteger(quantity) || quantity <= 0) return res.status(400).json({ success: false, error: "A valid investor and whole-cell quantity are required" });
    // Auto-creates the investor's wallet document if this is their first account-related action
    // (e.g. investing before ever visiting the wallet page) instead of failing with a confusing
    // "not found" error — same fix as deposit.js/withdraw.js.
    await ensureUserRecord(String(clerkId));
    let response;
    await session.withTransaction(async () => {
      const cluster = await clus.findById(req.params.id).session(session);
      if (!cluster) throw new Error("Cluster not found");
      if (cluster.status === "closed") throw new Error("This cluster has reached its final layer");
      if (cluster.status === "offline") throw new Error("This cluster has not been published yet");
      ensureCells(cluster);
      const isFirstLayer = cluster.currentLayer === 1;
      // At layer > 1 any cell can change hands (the current owner gets bought out at the live
      // price). Cells owned by someone else are offered first so real payouts happen; a buyer's
      // own cells are only used as a fallback once no other investor's cells remain this round,
      // so a single tester/admin account can still progress a layer without a second account.
      const available = isFirstLayer
        ? cluster.cells.filter((cell) => !cell.ownerClerkId)
        : [
            ...cluster.cells.filter((cell) => cell.ownerClerkId !== clerkId),
            ...cluster.cells.filter((cell) => cell.ownerClerkId === clerkId),
          ];
      const maxPurchasable = Math.min(available.length, Number(cluster.holderRemain) || 0);
      if (quantity > maxPurchasable) throw new Error(`Only ${maxPurchasable} cell(s) are available in layer ${cluster.currentLayer}`);
      const investedLayer = Number(cluster.currentLayer);
      const price = cellPrice(cluster);
      const total = quantity * price;
      const Users = getUsersCollection();
      const investor = await Users.findOne({ clerkId }, { session });
      if (!investor) throw new Error("Investor account not found");
      const investorAccount = accountFor(investor);
      const before = Number(investorAccount.balance || 0);
      if (before < total) throw new Error("Insufficient real account balance");
      investorAccount.balance = before - total;
      const debit = {
        type: "debit",
        category: "investment",
        amount: total,
        balanceBefore: before,
        balanceAfter: investorAccount.balance,
        description: `Layer ${cluster.currentLayer}: ${quantity} cell(s) in ${cluster.symbol}`,
        clusterId: String(cluster._id),
        clusterSymbol: cluster.symbol,
        layer: investedLayer,
        createdAt: new Date(),
      };
      await writeAccount(Users, clerkId, investor, investorAccount, debit, session);
      broadcastBalanceUpdate(String(clerkId), { balance: investorAccount.balance, accountType: "real" });

      const selected = available.slice(0, quantity);
      const ownerPayments = new Map();
      for (const cell of selected) {
        if (!cell.ownerClerkId) continue;
        const existing = ownerPayments.get(cell.ownerClerkId) || { amount: 0, costBasis: 0, cells: 0 };
        existing.amount += price;
        existing.costBasis += Number(cell.acquiredPrice || 0);
        existing.cells += 1;
        ownerPayments.set(cell.ownerClerkId, existing);
      }
      for (const [ownerClerkId, payment] of ownerPayments) {
        await creditOwner(Users, ownerClerkId, payment.amount, `Cell transferred in ${cluster.symbol}, layer ${cluster.currentLayer}`, session, {
          clusterId: String(cluster._id),
          clusterSymbol: cluster.symbol,
          layer: investedLayer,
          costBasis: payment.costBasis,
        });
        pushActivity(cluster, {
          type: "transfer",
          clerkId: ownerClerkId,
          counterpartyClerkId: clerkId,
          cells: payment.cells,
          amount: payment.amount,
          costBasis: payment.costBasis,
          layer: investedLayer,
        });
      }
      for (const cell of selected) Object.assign(cell, { ownerClerkId: clerkId, acquiredLayer: cluster.currentLayer, acquiredPrice: price, acquiredAt: new Date() });

      pushActivity(cluster, { type: "invest", clerkId, cells: quantity, amount: total, layer: investedLayer });

      cluster.holderPoint = Number(cluster.holderPoint || 0) + quantity;
      cluster.holderRemain = Number(cluster.expVolume) - cluster.holderPoint;
      cluster.actualVolume = Number(cluster.actualVolume || 0) + total;
      cluster.holders.push({ clerkId, cells: quantity, amount: total, investedAt: new Date() });
      const history = cluster.layerHistory.find((item) => item.layer === cluster.currentLayer);
      if (history) history.filledCells = cluster.holderPoint;
      if (cluster.currentLayer === 1) { const systemFee = total * Number(cluster.systemShareRate ?? SYSTEM_SHARE_RATE); cluster.systemReserve = Number(cluster.systemReserve || 0) + systemFee; cluster.recette = cluster.systemReserve; }

      let layerAdvanced = false, closed = false;
      if (cluster.holderRemain === 0) {
        if (history) history.completedAt = new Date();
        if (cluster.currentLayer >= cluster.maxLayers) {
          cluster.status = "closed";
          cluster.closedAt = new Date();
          closed = true;
          pushActivity(cluster, { type: "closed", layer: cluster.currentLayer });
        } else {
          cluster.currentLayer += 1;
          cluster.holderPoint = 0;
          cluster.holderRemain = cluster.expVolume;
          cluster.actualVolume = 0;
          cluster.holders = [];
          cluster.layerHistory.push({ layer: cluster.currentLayer, pricePerCell: cellPrice(cluster), filledCells: 0, openedAt: new Date() });
          layerAdvanced = true;
          pushActivity(cluster, { type: "layer_advance", layer: cluster.currentLayer });
        }
      }
      await cluster.save({ session });
      response = { cluster, balance: investorAccount.balance, total, price, investedLayer, layerAdvanced, closed, previousOwners: [...ownerPayments.keys()] };
    });
    await notify({ clerkId, type: "investment", title: "Investment confirmed", message: `You acquired ${quantity} cell(s) in ${response.cluster.symbol}, layer ${response.investedLayer}${response.layerAdvanced ? "; the next layer is now open." : ""}`, relatedId: String(response.cluster._id) });
    for (const ownerClerkId of response.previousOwners) await notify({ clerkId: ownerClerkId, type: "cell_transferred", title: "Cell transfer paid", message: `Your cell in ${response.cluster.symbol} was transferred and your account was credited.`, relatedId: String(response.cluster._id) });
    if (response.closed) await notify({ clerkId: process.env.TRIOMAC60_ADMIN_CLERK_ID, type: "cluster_closed", title: "Final layer complete", message: `${response.cluster.symbol} is now closed.`, relatedId: String(response.cluster._id) });
    return res.status(200).json({ success: true, data: response.cluster, wallet: { balance: response.balance }, investment: { amount: response.total, pricePerCell: response.price } });
  } catch (error) {
    console.error("Invest in cluster error:", error);
    return res.status(error.message === "Cluster not found" ? 404 : 400).json({ success: false, error: error.message });
  } finally {
    await session.endSession();
  }
});

clusterRouter.patch("/clusters/:id/publish", async (req, res) => {
  try {
    const { clerkId, adminCode } = req.body;
    if (!isAdmin(clerkId, adminCode)) return res.status(403).json({ success: false, error: "Only the triomac60 administrator or a valid admin code can publish clusters" });
    const cluster = await clus.findById(req.params.id);
    if (!cluster) return res.status(404).json({ success: false, error: "Cluster not found" });
    if (cluster.status !== "offline") return res.status(400).json({ success: false, error: "Only a draft cluster can be published" });
    cluster.status = "online";
    pushActivity(cluster, { type: "published", clerkId, layer: cluster.currentLayer });
    await cluster.save();
    await notify({ clerkId: process.env.TRIOMAC60_ADMIN_CLERK_ID, type: "cluster_published", title: "Cluster published", message: `${cluster.symbol} is now open for investment.`, relatedId: String(cluster._id) });
    return res.status(200).json({ success: true, data: cluster });
  } catch (error) {
    console.error("Publish cluster error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

clusterRouter.patch("/clusters/:id/close", async (req, res) => {
  try {
    const { clerkId, adminCode } = req.body;
    if (!isAdmin(clerkId, adminCode)) return res.status(403).json({ success: false, error: "Only the triomac60 administrator or a valid admin code can close clusters" });
    const cluster = await clus.findById(req.params.id);
    if (!cluster) return res.status(404).json({ success: false, error: "Cluster not found" });
    if (cluster.status === "closed") return res.status(400).json({ success: false, error: "Cluster is already closed" });
    cluster.status = "closed";
    cluster.closedAt = new Date();
    pushActivity(cluster, { type: "closed", clerkId, layer: cluster.currentLayer });
    await cluster.save();
    await notify({ clerkId: process.env.TRIOMAC60_ADMIN_CLERK_ID, type: "cluster_closed", title: "Cluster closed", message: `${cluster.symbol} was manually closed.`, relatedId: String(cluster._id) });
    return res.status(200).json({ success: true, data: cluster });
  } catch (error) {
    console.error("Close cluster error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

clusterRouter.delete("/clusters/:id", async (req, res) => {
  try {
    const { clerkId, adminCode } = req.body;
    if (!isAdmin(clerkId, adminCode)) return res.status(403).json({ success: false, error: "Only the triomac60 administrator or a valid admin code can delete clusters" });
    const cluster = await clus.findByIdAndDelete(req.params.id);
    if (!cluster) return res.status(404).json({ success: false, error: "Cluster not found" });
    return res.status(200).json({ success: true, data: { _id: req.params.id } });
  } catch (error) {
    console.error("Delete cluster error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

clusterRouter.delete("/clusters", async (req, res) => {
  try {
    const { clerkId, adminCode } = req.body;
    if (!isAdmin(clerkId, adminCode)) return res.status(403).json({ success: false, error: "Only the triomac60 administrator or a valid admin code can delete clusters" });
    const result = await clus.deleteMany({});
    return res.status(200).json({ success: true, deletedCount: result.deletedCount });
  } catch (error) {
    console.error("Delete all clusters error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

export default clusterRouter;
