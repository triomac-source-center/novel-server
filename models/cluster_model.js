import mongoose from "mongoose";

const { Schema } = mongoose;

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
