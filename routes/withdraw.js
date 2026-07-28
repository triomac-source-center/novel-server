import express from "express";
import { notify } from "../lib/notify.js";
import { broadcastBalanceUpdate } from "../lib/sse.js";
import { ensureUserRecord, getUsersCollection } from "../lib/user-account.js";

const withdrawRouter = express.Router();

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
    // Auto-creates the wallet document on first use instead of 404ing (see deposit.js) — a
    // freshly-created record has a real balance of $0, so the insufficient-balance check below
    // still correctly rejects a withdrawal for a user with nothing deposited yet.
    const user = await ensureUserRecord(String(clerkId));

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
