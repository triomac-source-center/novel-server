import express from "express";
import { retiredEndpoint } from "../lib/deprecated-route.js";

const withdrawRouter = express.Router();

// Retired: debited any clerkId's real balance by an arbitrary amount with zero verification and
// no actual fund movement. Real withdrawals now go through POST /wallet/withdraw (Clerk-verified).
withdrawRouter.post("/withdraw", retiredEndpoint("POST /wallet/withdraw (Clerk-authenticated)"));

export default withdrawRouter;
