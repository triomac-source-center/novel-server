import express from "express";
import { notify } from "../lib/notify.js";
import { broadcastBalanceUpdate } from "../lib/sse.js";
import { ensureUserRecord, getDefaultAccounts, getUsersCollection } from "../lib/user-account.js";

const depositRouter = express.Router();

depositRouter.post("/deposit", async (req, res) => {
  try {
    const { clerkId, amount, description } = req.body;

    if (!clerkId || typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ message: "Invalid deposit data" });
    }

    const Users = getUsersCollection();
    // Auto-creates the wallet document on first use instead of 404ing — the Clerk webhook that
    // normally seeds this record can miss a user (misconfigured, or the account predates it).
    const user = await ensureUserRecord(String(clerkId));

    const accounts = user.accounts || getDefaultAccounts();
    const currentRealAccount = accounts.real || getDefaultAccounts().real;
    const balanceBefore = currentRealAccount.balance ?? 0;
    const balanceAfter = balanceBefore + amount;

    const transaction = {
      type: "credit",
      category: "wallet",
      amount,
      balanceBefore,
      balanceAfter,
      description: description || "Wallet deposit",
      createdAt: new Date(),
    };

    const nextAccounts = {
      ...accounts,
      real: {
        ...currentRealAccount,
        balance: balanceAfter,
        transactions: [...(currentRealAccount.transactions || []), transaction],
        updatedAt: new Date(),
      },
    };

    const updatedUser = await Users.findOneAndUpdate(
      { clerkId },
      {
        $set: {
          accounts: nextAccounts,
          "wallet.balance": balanceAfter,
          "wallet.transactions": [...((user.wallet?.transactions || [])), transaction],
        },
      },
      { returnDocument: "after" }
    );

    broadcastBalanceUpdate(String(clerkId), { balance: balanceAfter, accountType: "real" });

    await notify({
      clerkId,
      type: "deposit",
      title: "Deposit received",
      message: `$${amount.toLocaleString()} was added to your real account.`,
    });

    res.status(200).json({
      message: "Deposit successful",
      wallet: {
        balance: balanceAfter,
        transactions: updatedUser.wallet?.transactions || [],
      },
      transaction,
    });
  } catch (error) {
    console.error("Deposit error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default depositRouter;
