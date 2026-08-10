// Manual deposit-detection worker. Run with: node scripts/detect-deposits.js
//
// Owns its own Mongo connection lifecycle (connect, run, disconnect, exit) — the actual detection
// logic lives in lib/deposit-detection.js, shared with the HTTP-triggered path so both can re-run
// safely against the same on-chain deposits with no risk of double-crediting.
import dotenv from "dotenv";
import mongoose from "mongoose";
import { runDepositDetection } from "../lib/deposit-detection.js";

dotenv.config();

async function run() {
  const mongoUri = process.env.MONGO_UI;
  if (!mongoUri) throw new Error("MONGO_UI environment variable is not set");
  await mongoose.connect(mongoUri);

  const { checked, credited, alreadyProcessed, errors } = await runDepositDetection();
  console.log(`Checked ${checked} deposit address(es).`);
  for (const entry of credited) {
    console.log(
      `[CREDITED] user=${entry.userId} address=${entry.address} amount=${entry.amount} ${entry.symbol} txid=${entry.txid} new_balance=${entry.newBalance}`
    );
  }
  for (const entry of alreadyProcessed) {
    console.log(`[ALREADY PROCESSED] txid=${entry.txid}${entry.race ? " (race with another run)" : ""} — skipped.`);
  }
  for (const entry of errors) {
    console.error(`Failed to check ${entry.address}:`, entry.error);
  }

  await mongoose.disconnect();
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("detect-deposits failed:", error);
    process.exit(1);
  });
