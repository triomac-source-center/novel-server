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
  // Denormalized from the DepositAddress this came from, so sweep-deposits.js can re-derive that
  // address's private key without an extra lookup. Not `required` — older records created before
  // this field existed fall back to a DepositAddress lookup by `address` in lib/deposit-sweep.js.
  derivationIndex: { type: Number, default: null },
  status: { type: String, enum: ["confirmed"], default: "confirmed" },
  creditedAt: { type: Date, default: Date.now },

  // On-chain sweep to the consolidated hot wallet — a separate step from crediting the user's
  // internal balance above, tracked independently.
  sweepStatus: { type: String, enum: ["pending", "funded", "swept", "failed"], default: "pending", index: true },
  fundingTxid: { type: String, default: null }, // TRX sent from the hot wallet to cover this address's gas
  sweepTxid: { type: String, default: null }, // USDT transfer from this address to the hot wallet
  sweepAttempts: { type: Number, default: 0 },
});

const Deposit = mongoose.model("deposits", DepositSchema);

export default Deposit;
