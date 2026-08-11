// On-chain sweep worker. Run with: node scripts/sweep-deposits.js
// Intended to run on a Render Cron Job (every 5 minutes) — owns its own Mongo connection
// lifecycle. The actual sweep logic (including the concurrency lock — see lib/cron-lock.js) lives
// in lib/deposit-sweep.js, shared with the HTTP-triggered path.
import dotenv from "dotenv";
import mongoose from "mongoose";
import { runDepositSweep } from "../lib/deposit-sweep.js";
import { sendAlert } from "../lib/alert.js";

dotenv.config();

async function run() {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGO_UI;
  if (!mongoUri) throw new Error("MONGO_UI environment variable is not set");
  await mongoose.connect(mongoUri);

  let result;
  try {
    result = await runDepositSweep({ log: (line) => console.log(line) });
  } finally {
    await mongoose.disconnect();
  }

  const durationMs = Date.now() - startedAt;

  if (result.skipped) {
    console.log(`[sweep-deposits] SUMMARY ${JSON.stringify({ skipped: true, reason: result.reason, durationMs })}`);
    return { errors: 0, durationMs };
  }

  const summary = {
    addressesChecked: result.addressesChecked,
    swept: result.swept.length,
    failed: result.failed.length,
    durationMs,
  };
  console.log(`[sweep-deposits] SUMMARY ${JSON.stringify(summary)}`);

  // A clean run with zero addresses to sweep is normal and never alerts — only real per-address
  // failures do.
  if (result.failed.length > 0) {
    const details = result.failed.map((f) => `- ${f.address} (${f.depositCount} deposit(s)): ${f.error}`).join("\n");
    await sendAlert(`⚠️ sweep-deposits.js: ${result.failed.length} address(es) failed to sweep.\n${details}`);
  }

  return { errors: result.failed.length, durationMs };
}

run()
  .then((summary) => {
    process.exit(summary.errors > 0 ? 1 : 0);
  })
  .catch(async (error) => {
    console.error("[sweep-deposits] FATAL:", error);
    await sendAlert(`🔴 sweep-deposits.js crashed: ${error.message}`);
    process.exit(1);
  });
