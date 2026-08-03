import mongoose from "mongoose";

const { Schema } = mongoose;

// Full chain of custody for a cell: one entry per owner, in order. The current owner's entry has
// releasedAt: null; every prior entry gets releasedAt set the moment the cell changes hands. This
// is what lets a cell's exact acquisition price/layer be audited at any point in its history, not
// just its current state.
const CellOwnershipEntrySchema = new Schema(
  {
    clerkId: { type: String, required: true },
    layer: { type: Number, required: true },
    price: { type: Number, required: true },
    acquiredAt: { type: Date, default: Date.now },
    releasedAt: { type: Date, default: null },
  },
  { _id: false }
);

const CellSchema = new Schema(
  {
    number: { type: Number, required: true },
    ownerClerkId: { type: String, default: null },
    acquiredLayer: { type: Number, default: 0 },
    acquiredPrice: { type: Number, default: 0 },
    acquiredAt: { type: Date, default: null },
    ownershipHistory: { type: [CellOwnershipEntrySchema], default: [] },
  },
  { _id: false }
);

const LayerSchema = new Schema(
  {
    layer: { type: Number, required: true },
    pricePerCell: { type: Number, required: true },
    filledCells: { type: Number, default: 0 },
    openedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { _id: false }
);

const ActivityLogSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["created", "published", "closed", "invest", "transfer", "layer_advance", "system_fee"],
      required: true,
    },
    clerkId: { type: String, default: null },
    counterpartyClerkId: { type: String, default: null },
    cells: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    costBasis: { type: Number, default: 0 },
    grossAmount: { type: Number, default: 0 },
    fee: { type: Number, default: 0 },
    layer: { type: Number, default: 1 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ClusterSchema = new Schema(
  {
    holderPoint: {
      type: Number,
      required: true,
    },

    entryPoint: {
      type: Number,
      required: true,
    },

    currentLayer: { type: Number, default: 1, min: 1 },
    maxLayers: { type: Number, default: 1, min: 1 },
    layerStep: { type: Number, default: 0, min: 0 },
    cells: { type: [CellSchema], default: [] },
    layerHistory: { type: [LayerSchema], default: [] },
    activityLog: { type: [ActivityLogSchema], default: [] },
    systemShareRate: { type: Number, default: 0.16, min: 0, max: 1 },
    systemReserve: { type: Number, default: 0, min: 0 },

    holders: {
      type: [
        {
          clerkId: { type: String, required: true },
          cells: { type: Number, required: true, min: 1 },
          amount: { type: Number, required: true, min: 0 },
          investedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
      _id: false,
    },

    name: {
      type: String,
      trim: true,
    },

    description: {
      type: String,
      trim: true,
      default: "",
    },

    expVolume: {
      type: Number,
      required: true,
    },

    actualVolume: {
      type: Number,
      required: true,
    },

    holderRemain: {
      type: Number,
      required: true,
    },
    creator: {
      type: String,
      required: true,
    },

    status: {
      type: String,
      enum: ["offline", "online", "closed"],
      default: "offline",
    },

    closedAt: {
      type: Date,
      default: null,
    },

    symbol: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },

    recette: {
      type: Number,
      default: 0,
    },

    algorythm: {
      type: String,
      required: true,
    },

    signature: {
      type: String,
      require: true,
      unique: true
    },

    createdAt: {
      type: Date,
      default: Date.now,
    }
  }
);

const clus =  mongoose.model("clusters", ClusterSchema);

export default clus;
