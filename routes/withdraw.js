import express from "express";
import mongoose from "mongoose";
import { notify } from "../lib/notify.js";
import { broadcastBalanceUpdate } from "../lib/sse.js";

const withdrawRouter = express.Router();

const getUsersCollection = () => mongoose.connection.collection("users");

withdrawRouter.post("/withdraw", async (req, res) => {
  try {
    const { clerkId, amount, description } = req.body;

    if (!clerkId) {
      return res.status(400).json({ message: "Missing clerkId" });
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ message: "Invalid withdrawal amount" });
    }

    const Users = getUsersCollection();
    const user = await Users.findOne({ clerkId });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const realAccount = user.accounts?.real || { balance: user.wallet?.balance ?? 0, transactions: [] };
    const currentBalance = Number(realAccount.balance ?? 0);

    if (parsedAmount > currentBalance) {
      return res.status(400).json({ message: "Insufficient balance" });
    }

    const balanceAfter = currentBalance - parsedAmount;

    const transaction = {
      type: "debit",
      category: "wallet",
      amount: parsedAmount,
      balanceBefore: currentBalance,
      balanceAfter,
      description: description || "Wallet withdrawal",
      createdAt: new Date(),
    };

    const nextAccounts = {
      ...(user.accounts || {}),
      real: {
        ...realAccount,
        balance: balanceAfter,
        transactions: [...(realAccount.transactions || []), transaction],
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
      type: "withdraw",
      title: "Withdrawal processed",
      message: `$${parsedAmount.toLocaleString()} was withdrawn from your real account.`,
    });

    return res.status(200).json({
      message: "Withdrawal successful",
      wallet: {
        balance: balanceAfter,
        transactions: updatedUser.wallet?.transactions || [],
      },
      transaction,
    });
  } catch (error) {
    console.error("Withdraw error:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

export default withdrawRouter;
