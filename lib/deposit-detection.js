// Core deposit-detection/crediting logic, shared between scripts/detect-deposits.js (which owns
// its own Mongo connection lifecycle) and any HTTP-triggered invocation (which reuses the app's
// already-open connection). This module never calls mongoose.connect/disconnect itself.
import mongoose from "mongoose";
import DepositAddress from "../models/deposit_address_model.js";
import Deposit from "../models/deposit_model.js";
import { creditUserBalance, ensureUserRecord } from "./user-account.js";
import { deriveTronAccount, HOT_WALLET_INDEX } from "./tron-wallet.js";

const MONGO_DUPLICATE_KEY_ERROR = 11000;

const TRON_FULL_HOST = process.env.TRON_FULL_HOST || "https://nile.trongrid.io";
// Nile testnet USDT (TRC20) contract, per the user — override via env if it ever changes.
const USDT_CONTRACT_ADDRESS = process.env.USDT_CONTRACT_ADDRESS || "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || null;

async function fetchIncomingTrc20Transfers(address) {
  const url = `${TRON_FULL_HOST}/v1/accounts/${address}/transactions/trc20?only_to=true&limit=20&contract_address=${USDT_CONTRACT_ADDRESS}`;
  const headers = { Accept: "application/json" };
  if (TRONGRID_API_KEY) headers["TRON-PRO-API-KEY"] = TRONGRID_API_KEY;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`TronGrid request failed for ${address}: ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  return Array.isArray(body.data) ? body.data : [];
}

function formatAmount(rawValue, decimals) {
  const divisor = 10 ** Number(decimals || 6);
  return Number(rawValue) / divisor;
}

// Creates the Deposit record and credits the user's balance in one atomic transaction — either
// both happen or neither does. Returns null when the deposit turns out to already be processed,
// including the race case where two runs both pass the pre-check and one loses on the unique
// index at insert time.
async function creditDeposit(record, transfer, amount) {
  // Same defensive pattern used everywhere else in this backend (invest handler, deposit.js,
  // withdraw.js, authorship blocks) — a deposit address can exist for a clerkId that has never
  // otherwise touched the users collection (it only requires a DepositAddress row to be issued).
  await ensureUserRecord(record.userId);

  const session = await mongoose.startSession();
  try {
    let newBalance = null;
    await session.withTransaction(async () => {
      await Deposit.create(
        [
          {
            userId: record.userId,
            txid: transfer.transaction_id,
            amount,
            address: record.address,
            derivationIndex: record.derivationIndex,
            status: "confirmed",
          },
        ],
        { session }
      );
      newBalance = await creditUserBalance(
        record.userId,
        amount,
        `TRC20 USDT deposit (txid ${transfer.transaction_id})`,
        session,
        { category: "crypto_deposit" }
      );
    });
    return newBalance;
  } catch (error) {
    if (error.code === MONGO_DUPLICATE_KEY_ERROR) {
      return null;
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

// Runs one full pass over every stored deposit address. Returns a summary instead of just
// logging, so an HTTP caller can inspect exactly what happened; the console logging callers care
// about (the CLI script) is left to them.
export async function runDepositDetection() {
  const addresses = await DepositAddress.find({});
  // Any transfer whose source is an address WE control (the hot wallet, or any tracked deposit
  // address) is an internal system movement (a sweep, or a withdrawal payout to a tracked
  // address), never a genuine external deposit — crediting it would double-count money the user
  // already has. Built from the same DepositAddress query above, no extra DB round-trip.
  const hotWallet = deriveTronAccount(HOT_WALLET_INDEX);
  const internalAddresses = new Set([hotWallet.address, ...addresses.map((a) => a.address)]);

  const credited = [];
  const alreadyProcessed = [];
  const ignoredInternal = [];
  const errors = [];

  for (const record of addresses) {
    try {
      const transfers = await fetchIncomingTrc20Transfers(record.address);
      for (const transfer of transfers) {
        if (internalAddresses.has(transfer.from)) {
          ignoredInternal.push({ txid: transfer.transaction_id, from: transfer.from, to: record.address, userId: record.userId });
          continue;
        }

        const existing = await Deposit.findOne({ txid: transfer.transaction_id });
        if (existing) {
          alreadyProcessed.push({ txid: transfer.transaction_id, userId: record.userId });
          continue;
        }

        const amount = formatAmount(transfer.value, transfer.token_info?.decimals);
        const newBalance = await creditDeposit(record, transfer, amount);
        if (newBalance === null) {
          alreadyProcessed.push({ txid: transfer.transaction_id, userId: record.userId, race: true });
        } else {
          credited.push({
            userId: record.userId,
            address: record.address,
            amount,
            symbol: transfer.token_info?.symbol || "USDT",
            txid: transfer.transaction_id,
            newBalance,
          });
        }
      }
    } catch (error) {
      errors.push({ address: record.address, userId: record.userId, error: error.message });
    }
  }

  return { checked: addresses.length, credited, alreadyProcessed, ignoredInternal, errors };
}
