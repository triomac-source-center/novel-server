import mongoose from "mongoose";

const { Schema } = mongoose;

// userId stores the Clerk ID directly (a plain string), matching every other collection in this
// backend (users, clusters.holders, authorship_blocks.ownerClerkId, ...) — none of them use a
// Mongo ObjectId ref, always the raw Clerk ID.
const DepositAddressSchema = new Schema({
  userId: { type: String, required: true, unique: true },
  derivationIndex: { type: Number, required: true, unique: true },
  address: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const DepositAddress = mongoose.model("deposit_addresses", DepositAddressSchema);

export default DepositAddress;
