import express from "express";
import mongoose from "mongoose";
import { requireAuth, getAuth } from "@clerk/express";
import clus from "../models/cluster_model.js";
import AuthorshipBlock from "../models/authorship_block_model.js";
import { notify } from "../lib/notify.js";
import { broadcastBalanceUpdate } from "../lib/sse.js";
import { ensureUserRecord } from "../lib/user-account.js";
import { computeCommittedFunds } from "../lib/available-funds.js";
import { requireAdminAccess } from "../lib/admin.js";

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

function pushActivity(cluster, entry) {
  cluster.activityLog.push({ createdAt: new Date(), ...entry });
}

// Records a cell changing hands (first purchase or a later transfer) in its own ownershipHistory
// instead of just overwriting the current-owner fields — closes the previous owner's entry
// (releasedAt) if there was one, then appends the new owner's entry. The current-state fields
// (ownerClerkId, acquiredLayer, acquiredPrice, acquiredAt) are kept in sync exactly as before, so
// every existing read of those fields is unaffected.
function recordCellAcquisition(cell, clerkId, layer, price, at) {
  if (!Array.isArray(cell.ownershipHistory)) cell.ownershipHistory = [];
  for (const entry of cell.ownershipHistory) {
    if (!entry.releasedAt) entry.releasedAt = at;
  }
  cell.ownershipHistory.push({ clerkId, layer, price, acquiredAt: at, releasedAt: null });
  Object.assign(cell, { ownerClerkId: clerkId, acquiredLayer: layer, acquiredPrice: price, acquiredAt: at });
}

// When a layer completes, several different owners can each hold a different quantity of its
// cells (e.g. 4/3/3 out of 10). If a buyer only wants part of what's left, cycling one cell per
// owner in turn (instead of draining owners in raw array order) means a partial purchase still
// pays out proportionally across everyone still holding cells that round, not just whichever
// owner's cells happen to sit first in the array.
function roundRobinByOwner(cells) {
  const byOwner = new Map();
  for (const cell of cells) {
    const key = cell.ownerClerkId;
    if (!byOwner.has(key)) byOwner.set(key, []);
    byOwner.get(key).push(cell);
  }
  let buckets = [...byOwner.values()];
  const result = [];
  while (buckets.length > 0) {
    const next = [];
    for (const bucket of buckets) {
      result.push(bucket.shift());
      if (bucket.length > 0) next.push(bucket);
    }
    buckets = next;
  }
  return result;
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
      category: meta.category ?? "investment",
      amount,
      balanceBefore: before,
      balanceAfter: account.balance,
      description,
      clusterId: meta.clusterId ?? null,
      clusterSymbol: meta.clusterSymbol ?? null,
      layer: meta.layer ?? null,
      costBasis: meta.costBasis ?? 0,
      grossAmount: meta.grossAmount ?? amount,
      fee: meta.fee ?? 0,
      createdAt: new Date(),
    },
    session
  );
  broadcastBalanceUpdate(String(clerkId), { balance: account.balance, accountType: "real" });
}

clusterRouter.post("/clusters", requireAdminAccess, async (req, res) => {
  try {
    const { userId: clerkId } = getAuth(req);
    const { symbol, name, description, algorythm, cellCount, cellValue, maxLayers = 1, layerStep = 0 } = req.body;
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

    // One Authorship Block per layer, precomputed from the fixed price schedule: layer 1 has no
    // seller (fresh sale, full gross taxed), every layer after that only taxes the profit margin,
    // which is a constant `layerStep` per cell under normal one-transfer-per-layer trading.
    const blockDocs = [];
    for (let layer = 1; layer <= layers; layer += 1) {
      const expectedShareAmount = layer === 1 ? count * value * SYSTEM_SHARE_RATE : count * step * SYSTEM_SHARE_RATE;
      blockDocs.push({
        clusterId: cluster._id,
        clusterSymbol: cluster.symbol,
        layer,
        expectedShareAmount,
        originalPrice: expectedShareAmount / 2,
      });
    }
    await AuthorshipBlock.insertMany(blockDocs);

    await notify({ clerkId, type: "cluster_created", title: "Cluster created (draft)", message: `${cluster.symbol} was created as a draft. Publish it to open it for investment.`, relatedId: String(cluster._id) });
    return res.status(201).json({ success: true, data: cluster });
  } catch (error) {
    console.error("Create cluster error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

clusterRouter.post("/clusters/:id/invest", requireAuth(), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { userId: clerkId } = getAuth(req);
    const { cells } = req.body;
    const quantity = Number(cells);
    if (!Number.isInteger(quantity) || quantity <= 0) return res.status(400).json({ success: false, error: "A valid whole-cell quantity is required" });
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
      // Cells already claimed THIS layer (acquiredLayer === currentLayer) are excluded from resale
      // until the next layer opens — otherwise a cell bought a moment ago at this layer's price
      // could be immediately bought out again at the same price by a different buyer, producing a
      // $0-profit "phantom flip" instead of only becoming tradeable once the price actually moves.
      const available = isFirstLayer
        ? cluster.cells.filter((cell) => !cell.ownerClerkId)
        : [
            ...roundRobinByOwner(
              cluster.cells.filter((cell) => cell.ownerClerkId !== clerkId && cell.acquiredLayer !== cluster.currentLayer)
            ),
            ...cluster.cells.filter((cell) => cell.ownerClerkId === clerkId),
          ];
      const maxPurchasable = Math.min(available.length, Number(cluster.holderRemain) || 0);
      // Reject the whole request outright when demand exceeds supply — never auto-fill a smaller
      // quantity than what was asked for. Nothing is debited and no cell changes hands; the buyer
      // has to explicitly ask again with a lower number.
      if (quantity > maxPurchasable) {
        throw new Error(`Purchase impossible: only ${maxPurchasable} cell(s) are available at this layer, you requested ${quantity}.`);
      }
      const investedLayer = Number(cluster.currentLayer);
      const price = cellPrice(cluster);
      const total = quantity * price;
      const Users = getUsersCollection();
      const investor = await Users.findOne({ clerkId }, { session });
      if (!investor) throw new Error("Investor account not found");
      const investorAccount = accountFor(investor);
      const before = Number(investorAccount.balance || 0);
      // MT5-style: Balance never moves on a purchase — only when a profit is actually realized
      // (see creditOwner below). What CAN'T happen is spending money already committed to other
      // still-open positions, so the affordability check is against available funds (balance minus
      // the cost basis of everything currently held), not the raw balance field.
      const committed = await computeCommittedFunds(clerkId, session);
      const availableFunds = before - committed;
      if (availableFunds < total) throw new Error("Insufficient available funds (balance minus your currently open positions).");
      const debit = {
        type: "debit",
        category: "investment",
        amount: total,
        balanceBefore: before,
        balanceAfter: before,
        description: `Layer ${cluster.currentLayer}: ${quantity} cell(s) in ${cluster.symbol}`,
        clusterId: String(cluster._id),
        clusterSymbol: cluster.symbol,
        layer: investedLayer,
        createdAt: new Date(),
      };
      await writeAccount(Users, clerkId, investor, investorAccount, debit, session);

      const selected = available.slice(0, quantity);
      const systemRate = Number(cluster.systemShareRate ?? SYSTEM_SHARE_RATE);
      const ownerPayments = new Map();
      let freshCells = 0;
      for (const cell of selected) {
        if (!cell.ownerClerkId) {
          freshCells += 1;
          continue;
        }
        const existing = ownerPayments.get(cell.ownerClerkId) || { grossAmount: 0, costBasis: 0, cells: 0 };
        existing.grossAmount += price;
        existing.costBasis += Number(cell.acquiredPrice || 0);
        existing.cells += 1;
        ownerPayments.set(cell.ownerClerkId, existing);
      }
      // The system owns 16% of every layer, on every cluster, full stop — but computed on the
      // PROFIT margin of each transfer, not the full sale amount (taking 16% of the whole sale
      // amount was tried and reverted: on a thin margin relative to the original cost, it could eat
      // most of the actual gain — e.g. a $340 profit on a $1,560 sale lost $249.60 to fees, 73% of
      // the profit, not 16%). Two cases fund that reserve:
      //  1) Fresh cells (no previous owner, i.e. layer 1): there's no seller/cost-basis to net
      //     against, so the system keeps 16% of what the buyer paid as its cut of this layer.
      //  2) Transferred cells (layer 2+): the seller is paid their cost basis back in full plus 84%
      //     of what they gained on the resale; the system takes 16% of that gain specifically,
      //     computed per owner and per transfer, not deferred to layer completion.
      let systemFeeTotal = 0;
      let feeCells = 0;
      if (freshCells > 0) {
        const freshFee = freshCells * price * systemRate;
        systemFeeTotal += freshFee;
        feeCells += freshCells;
      }
      for (const [ownerClerkId, payment] of ownerPayments) {
        const profit = payment.grossAmount - payment.costBasis;
        const fee = profit > 0 ? profit * systemRate : 0;
        const netAmount = payment.grossAmount - fee;
        systemFeeTotal += fee;
        feeCells += payment.cells;
        // Credit only the REALIZED GAIN (netAmount minus the seller's own cost basis) — not the
        // full sale proceeds. Buying a cell no longer debits the balance (see the purchase debit
        // above: balanceAfter === balanceBefore), so the cost basis was never removed from balance
        // in the first place; crediting the full netAmount back would double-count it on top of the
        // gain the seller actually made.
        const netGain = netAmount - payment.costBasis;
        await creditOwner(Users, ownerClerkId, netGain, `Cell transferred in ${cluster.symbol}, layer ${cluster.currentLayer}`, session, {
          clusterId: String(cluster._id),
          clusterSymbol: cluster.symbol,
          layer: investedLayer,
          costBasis: payment.costBasis,
          grossAmount: payment.grossAmount,
          fee,
        });
        pushActivity(cluster, {
          type: "transfer",
          clerkId: ownerClerkId,
          counterpartyClerkId: clerkId,
          cells: payment.cells,
          amount: netAmount,
          grossAmount: payment.grossAmount,
          costBasis: payment.costBasis,
          fee,
          layer: investedLayer,
        });
      }
      if (systemFeeTotal > 0) {
        // If someone pre-bought this exact cluster+layer's future system share as an Authorship
        // Block, the system was already paid (at half price, at block-purchase time) — so this
        // layer's real fee is redirected to the block owner instead of the system, in full, and
        // does NOT also add to systemReserve (that would double-count the same revenue).
        const block = await AuthorshipBlock.findOne({ clusterId: cluster._id, layer: investedLayer, status: { $in: ["sold", "paid_out"] } }).session(session);
        if (block && block.ownerClerkId) {
          // Same principle as the cell transfer above: buying the block never touched balance, so
          // only the portion above what the current owner paid for it is a real gain. If the layer
          // fills across several separate purchases, this block's payout can arrive in more than
          // one installment — the cost basis is only subtracted from the FIRST one; the rest is
          // pure gain (it's already been accounted for).
          const isFirstPayout = Number(block.paidOutAmount || 0) === 0;
          const blockCostBasis = isFirstPayout
            ? Number((block.ownershipHistory || []).find((entry) => !entry.releasedAt)?.price ?? 0)
            : 0;
          const netGain = systemFeeTotal - blockCostBasis;
          await creditOwner(Users, block.ownerClerkId, netGain, `Authorship block payout: ${cluster.symbol} layer ${investedLayer}`, session, {
            clusterId: String(cluster._id),
            clusterSymbol: cluster.symbol,
            layer: investedLayer,
            costBasis: blockCostBasis,
            grossAmount: systemFeeTotal,
            category: "block",
          });
          block.paidOutAmount = Number(block.paidOutAmount || 0) + systemFeeTotal;
          block.status = "paid_out";
          block.paidOutAt = block.paidOutAt || new Date();
          await block.save({ session });
          pushActivity(cluster, { type: "block_payout", clerkId: block.ownerClerkId, amount: systemFeeTotal, cells: feeCells, layer: investedLayer });
        } else {
          cluster.systemReserve = Number(cluster.systemReserve || 0) + systemFeeTotal;
          cluster.recette = cluster.systemReserve;
          pushActivity(cluster, { type: "system_fee", amount: systemFeeTotal, cells: feeCells, layer: investedLayer });
        }
      }
      const acquiredAt = new Date();
      for (const cell of selected) recordCellAcquisition(cell, clerkId, cluster.currentLayer, price, acquiredAt);

      pushActivity(cluster, { type: "invest", clerkId, cells: quantity, amount: total, layer: investedLayer });

      cluster.holderPoint = Number(cluster.holderPoint || 0) + quantity;
      cluster.holderRemain = Number(cluster.expVolume) - cluster.holderPoint;
      cluster.actualVolume = Number(cluster.actualVolume || 0) + total;
      cluster.holders.push({ clerkId, cells: quantity, amount: total, investedAt: new Date() });
      const history = cluster.layerHistory.find((item) => item.layer === cluster.currentLayer);
      if (history) history.filledCells = cluster.holderPoint;

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

clusterRouter.patch("/clusters/:id/publish", requireAdminAccess, async (req, res) => {
  try {
    const { userId: clerkId } = getAuth(req);
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

clusterRouter.patch("/clusters/:id/close", requireAdminAccess, async (req, res) => {
  try {
    const { userId: clerkId } = getAuth(req);
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

clusterRouter.delete("/clusters/:id", requireAdminAccess, async (req, res) => {
  try {
    const cluster = await clus.findByIdAndDelete(req.params.id);
    if (!cluster) return res.status(404).json({ success: false, error: "Cluster not found" });
    // Otherwise these would be orphaned, pointing at a cluster that no longer exists (same "no
    // refund" stance as a cluster that closes without reaching a layer — see block payout logic).
    await AuthorshipBlock.deleteMany({ clusterId: cluster._id });
    return res.status(200).json({ success: true, data: { _id: req.params.id } });
  } catch (error) {
    console.error("Delete cluster error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

clusterRouter.delete("/clusters", requireAdminAccess, async (req, res) => {
  try {
    const result = await clus.deleteMany({});
    await AuthorshipBlock.deleteMany({});
    return res.status(200).json({ success: true, deletedCount: result.deletedCount });
  } catch (error) {
    console.error("Delete all clusters error:", error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

export default clusterRouter;
