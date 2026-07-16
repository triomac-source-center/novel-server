import mongoose from "mongoose";

const { Schema } = mongoose;

const CellSchema = new Schema(
  {
    number: { type: Number, required: true },
    ownerClerkId: { type: String, default: null },
    acquiredLayer: { type: Number, default: 0 },
    acquiredPrice: { type: Number, default: 0 },
    acquiredAt: { type: Date, default: null },
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
