// Manual deposit-detection worker. Run with: node scripts/detect-deposits.js
//
// For every address in DepositAddress, asks TronGrid for its recent incoming USDT (TRC20)
// transfers on Nile testnet. Each transfer not already recorded in Deposit gets credited to the
// depositor's real balance and recorded, atomically, in the same Mongo transaction — so the
// script is safe to re-run against the same on-chain deposits with no risk of double-crediting
// (Deposit.txid's unique index is the final guard even against a race between two runs).
import dotenv from "dotenv";
import mongoose from "mongoose";
import DepositAddress from "../models/deposit_address_model.js";
import Deposit from "../models/deposit_model.js";
import { creditUserBalance } from "../lib/user-account.js";

dotenv.config();

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
// both happen or neither does, so a Deposit row can never exist without the matching credit (or
// vice versa). Returns null (and logs why) when the deposit turns out to already be processed,
// including the race case where two runs both pass the pre-check and one loses on the unique
// index at insert time.
async function creditDeposit(record, transfer, amount) {
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
      console.log(`[ALREADY PROCESSED] txid=${transfer.transaction_id} (race with another run) — skipped.`);
      return null;
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function run() {
  const mongoUri = process.env.MONGO_UI;
  if (!mongoUri) throw new Error("MONGO_UI environment variable is not set");
  await mongoose.connect(mongoUri);

  const addresses = await DepositAddress.find({});
  console.log(`Checking ${addresses.length} deposit address(es) for incoming USDT (TRC20) on ${TRON_FULL_HOST}...`);

  for (const record of addresses) {
    try {
      const transfers = await fetchIncomingTrc20Transfers(record.address);
      if (transfers.length === 0) continue;

      for (const transfer of transfers) {
        const alreadyProcessed = await Deposit.findOne({ txid: transfer.transaction_id });
        if (alreadyProcessed) {
          console.log(`[ALREADY PROCESSED] txid=${transfer.transaction_id} — skipped.`);
          continue;
        }

        const amount = formatAmount(transfer.value, transfer.token_info?.decimals);
        const newBalance = await creditDeposit(record, transfer, amount);
        if (newBalance !== null) {
          console.log(
            `[CREDITED] user=${record.userId} address=${record.address} amount=${amount} ${transfer.token_info?.symbol || "USDT"} txid=${transfer.transaction_id} new_balance=${newBalance}`
          );
        }
      }
    } catch (error) {
      console.error(`Failed to check ${record.address}:`, error.message);
    }
  }

  await mongoose.disconnect();
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("detect-deposits failed:", error);
    process.exit(1);
  });
