import express from "express";
import Clus from "../models/cluster_model.js";

const allClusRouter = express.Router();

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

allClusRouter.get("/clusters/:id", async (req, res) => {
  try {
    const cluster = await Clus.findById(req.params.id);

    if (!cluster) {
      return res.status(404).json({ success: false, error: "Cluster not found" });
    }

    return res.status(200).json({
      success: true,
      data: cluster,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default allClusRouter;
