import mongoose from "mongoose";

const { Schema } = mongoose;

// txid's unique index is the actual idempotency guarantee — even a race between two concurrent
// script runs can't credit the same on-chain deposit twice, since MongoDB itself rejects the
// second insert.
const DepositSchema = new Schema({
  userId: { type: String, required: true, index: true },
  txid: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  address: { type: String, required: true },
  status: { type: String, enum: ["confirmed"], default: "confirmed" },
  creditedAt: { type: Date, default: Date.now },
});

const Deposit = mongoose.model("deposits", DepositSchema);

export default Deposit;
