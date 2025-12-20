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
      type: [String],
      default: [],
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
      enum: ["offline", "online"],
      default: "offline",
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
