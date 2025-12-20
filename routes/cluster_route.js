import express from "express";
import clus from "../models/cluster_model.js";

const clusterRouter = express.Router();

clusterRouter.post("/clus", async (req, res) => {
  try {

  const data = {
    holderPoint: 5,
    entryPoint: 7,
    holders: [],
    expVolume: 35,
    actualVolume: 0,
    holderRemain: 5,
    creator: "user_36th2gls87icMXDLg7CH4HcmThE",
    status: "offline",
    symbol: "CENL",
    recette: 6,
    signature: "DNW4ZI5T3VOU7OA",
    algorythm: "mean-reversion"
  }
    const clusy = await clus.create(data);

    return res.status(201).json({
      success: true,
      data: clusy,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

export default clusterRouter;
