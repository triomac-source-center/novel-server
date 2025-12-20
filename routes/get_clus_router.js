import express from "express";
import mongoose from "mongoose";

const allClusRouter = express.Router();

const Clus = mongoose.model("clusters");

allClusRouter.get("/clusters", async (req, res) => {
  try {
    const clusList = await Clus.find().sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: clusList.length,
      data: clusList,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default allClusRouter;
