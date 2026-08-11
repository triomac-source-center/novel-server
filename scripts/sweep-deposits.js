// Manual on-chain sweep worker. Run with: node scripts/sweep-deposits.js
//
// Owns its own Mongo connection lifecycle — the actual sweep logic lives in
// lib/deposit-sweep.js, shared with the HTTP-triggered path.
import dotenv from "dotenv";
import mongoose from "mongoose";
import { runDepositSweep } from "../lib/deposit-sweep.js";

dotenv.config();

async function run() {
  const mongoUri = process.env.MONGO_UI;
  if (!mongoUri) throw new Error("MONGO_UI environment variable is not set");
  await mongoose.connect(mongoUri);

  await runDepositSweep({ log: (line) => console.log(line) });

  await mongoose.disconnect();
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("sweep-deposits failed:", error);
    process.exit(1);
  });
