import express from "express";
import { retiredEndpoint } from "../lib/deprecated-route.js";

const depositRouter = express.Router();

// Retired: minted arbitrary real balance for any clerkId with zero verification. Real deposits now
// go through the TRON module (GET /wallet/deposit-address + on-chain detection).
depositRouter.post("/deposit", retiredEndpoint("GET /wallet/deposit-address (real TRC20 USDT deposit)"));

export default depositRouter;
