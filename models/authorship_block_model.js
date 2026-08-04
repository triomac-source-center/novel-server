import mongoose from "mongoose";

const { Schema } = mongoose;

// Same pattern as CellSchema's ownershipHistory: one entry per owner, current owner's entry has
// releasedAt: null.
const BlockOwnershipEntrySchema = new Schema(
  {
    clerkId: { type: String, required: true },
    price: { type: Number, required: true },
    acquiredAt: { type: Date, default: Date.now },
    releasedAt: { type: Date, default: null },
  },
  { _id: false }
);

const AuthorshipBlockSchema = new Schema({
  clusterId: { type: Schema.Types.ObjectId, ref: "clusters", required: true },
  clusterSymbol: { type: String, required: true },
  layer: { type: Number, required: true },
  // Precomputed at cluster creation from the fixed price schedule: the exact 16% system share this
  // layer will generate once it's actually reached and traded.
  expectedShareAmount: { type: Number, required: true },
  // Fixed at creation, never changes: expectedShareAmount / 2. This is what the system receives on
  // the block's first (initial) sale — resales are peer-to-peer at whatever the owner lists.
  originalPrice: { type: Number, required: true },
  status: { type: String, enum: ["available", "sold", "paid_out"], default: "available" },
  ownerClerkId: { type: String, default: null },
  listedForResale: { type: Boolean, default: false },
  resalePrice: { type: Number, default: null },
  ownershipHistory: { type: [BlockOwnershipEntrySchema], default: [] },
  // Real amount actually redirected from system_fee events for this cluster+layer — accumulates if
  // the layer fills across multiple separate purchases, so it can differ slightly from
  // expectedShareAmount if trading deviates from the clean one-transfer-per-layer case.
  paidOutAmount: { type: Number, default: 0 },
  paidOutAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

const AuthorshipBlock = mongoose.model("authorship_blocks", AuthorshipBlockSchema);

export default AuthorshipBlock;
