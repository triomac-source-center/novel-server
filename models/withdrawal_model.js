import mongoose from "mongoose";

const { Schema } = mongoose;

// status flow: pending -> processing -> completed
//                                    \-> failed (balance auto-refunded)
//              pending_review is a dead-end until an operator manually moves it back to pending
//              (amount exceeded WITHDRAWAL_MANUAL_REVIEW_THRESHOLD at request time).
const WithdrawalSchema = new Schema({
  userId: { type: String, required: true, index: true },
  toAddress: { type: String, required: true },
  amount: { type: Number, required: true },
  status: {
    type: String,
    enum: ["pending", "pending_review", "processing", "completed", "failed"],
    default: "pending",
    index: true,
  },
  txid: { type: String, default: null },
  requestedAt: { type: Date, default: Date.now },
  processedAt: { type: Date, default: null },
});

const Withdrawal = mongoose.model("withdrawals", WithdrawalSchema);

export default Withdrawal;
