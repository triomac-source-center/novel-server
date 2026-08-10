// Manual deposit-detection worker. Run with: node scripts/detect-deposits.js
//
// For every address in DepositAddress, asks TronGrid for its recent incoming USDT (TRC20)
// transfers on Nile testnet and logs each one (address, amount, txid). Does NOT credit any
// balance yet — that comes in a later step, once we decide how to dedupe against transactions
// already credited (this pass will happily re-log the same transfer on every run).
import dotenv from "dotenv";
import mongoose from "mongoose";
import DepositAddress from "../models/deposit_address_model.js";

dotenv.config();

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
        const amount = formatAmount(transfer.value, transfer.token_info?.decimals);
        console.log(
          `[DEPOSIT DETECTED] user=${record.userId} address=${record.address} amount=${amount} ${transfer.token_info?.symbol || "USDT"} txid=${transfer.transaction_id} from=${transfer.from}`
        );
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
