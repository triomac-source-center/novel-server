import express from "express";
import mongoose from "mongoose";

const depositRouter = express.Router();
const Users = mongoose.connection.collection("users");

const getDefaultAccounts = () => ({
  demo: {
    balance: 10000,
    currency: "USD",
    transactions: [],
    updatedAt: new Date(),
  },
  real: {
    balance: 0,
    currency: "USD",
    transactions: [],
    updatedAt: new Date(),
  },
});

depositRouter.post("/deposit", async (req, res) => {
  try {
    const { clerkId, amount, description } = req.body;

    if (!clerkId || typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ message: "Invalid deposit data" });
    }

    const user = await Users.findOne({ clerkId });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const accounts = user.accounts || getDefaultAccounts();
    const currentRealAccount = accounts.real || getDefaultAccounts().real;
    const balanceBefore = currentRealAccount.balance ?? 0;
    const balanceAfter = balanceBefore + amount;

    const transaction = {
      type: "credit",
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
