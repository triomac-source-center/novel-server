// Manual withdrawal-processing worker. Run with: node scripts/process-withdrawals.js
//
// Owns its own Mongo connection lifecycle — the actual processing logic lives in
// lib/withdrawal-processing.js, shared with the HTTP-triggered path.
import dotenv from "dotenv";
import mongoose from "mongoose";
import { runWithdrawalProcessing } from "../lib/withdrawal-processing.js";

dotenv.config();

async function run() {
  const mongoUri = process.env.MONGO_UI;
  if (!mongoUri) throw new Error("MONGO_UI environment variable is not set");
  await mongoose.connect(mongoUri);

  await runWithdrawalProcessing({ log: (line) => console.log(line) });

  await mongoose.disconnect();
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("process-withdrawals failed:", error);
    process.exit(1);
  });
