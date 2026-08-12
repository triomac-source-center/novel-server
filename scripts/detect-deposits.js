// Deposit-detection worker. Run with: node scripts/detect-deposits.js
// Intended to run on a Render Cron Job (every 2 minutes) — owns its own Mongo connection
// lifecycle (connect, run, disconnect, exit). The actual detection logic lives in
// lib/deposit-detection.js, shared with the HTTP-triggered path so both can re-run safely against
// the same on-chain deposits with no risk of double-crediting (unique txid index).
import dotenv from "dotenv";
import mongoose from "mongoose";
import { runDepositDetection } from "../lib/deposit-detection.js";
import { sendAlert } from "../lib/alert.js";

dotenv.config();

async function run() {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGO_UI;
  if (!mongoUri) throw new Error("MONGO_UI environment variable is not set");
  await mongoose.connect(mongoUri);

  let result;
  try {
    result = await runDepositDetection();
  } finally {
    await mongoose.disconnect();
  }

  for (const entry of result.credited) {
    console.log(
      `[CREDITED] user=${entry.userId} address=${entry.address} amount=${entry.amount} ${entry.symbol} txid=${entry.txid} new_balance=${entry.newBalance}`
    );
  }
  for (const entry of result.alreadyProcessed) {
    console.log(`[ALREADY PROCESSED] txid=${entry.txid}${entry.race ? " (race with another run)" : ""} — skipped.`);
  }
  for (const entry of result.ignoredInternal) {
    console.log(`[IGNORED INTERNAL] txid=${entry.txid} from=${entry.from} to=${entry.to} (userId=${entry.userId}) — internal system transfer, not an external deposit.`);
  }
  for (const entry of result.errors) {
    console.error(`[ERROR] address=${entry.address} userId=${entry.userId}: ${entry.error}`);
  }

  const durationMs = Date.now() - startedAt;
  const summary = {
    checked: result.checked,
    credited: result.credited.length,
    alreadyProcessed: result.alreadyProcessed.length,
    ignoredInternal: result.ignoredInternal.length,
    errors: result.errors.length,
    durationMs,
  };
  console.log(`[detect-deposits] SUMMARY ${JSON.stringify(summary)}`);

  // "No deposits found" is a normal, expected outcome and never alerts — only real per-address
  // failures (TronGrid errors, derivation issues, etc.) do.
  if (result.errors.length > 0) {
    const details = result.errors.map((e) => `- ${e.address} (${e.userId}): ${e.error}`).join("\n");
    await sendAlert(`⚠️ detect-deposits.js: ${result.errors.length} error(s) this run.\n${details}`);
  }

  return summary;
}

run()
  .then((summary) => {
    process.exit(summary.errors > 0 ? 1 : 0);
  })
  .catch(async (error) => {
    console.error("[detect-deposits] FATAL:", error);
    await sendAlert(`🔴 detect-deposits.js crashed: ${error.message}`);
    process.exit(1);
  });
