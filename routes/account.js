import express from "express";
import { notify } from "../lib/notify.js";
import { addSseClient, broadcastBalanceUpdate } from "../lib/sse.js";
import { ensureUserRecord, getDefaultAccounts, getUsersCollection, normalizeAccount } from "../lib/user-account.js";
import { retiredEndpoint } from "../lib/deprecated-route.js";

const accountRouter = express.Router();

accountRouter.get("/account", async (req, res) => {
  try {
    const { clerkId, type = "real" } = req.query;

    if (!clerkId) {
      return res.status(400).json({ message: "Missing clerkId" });
    }

    const user = await ensureUserRecord(String(clerkId));
    const accounts = user.accounts || getDefaultAccounts();
    const normalizedType = type === "demo" ? "demo" : "real";
    const account = normalizeAccount(accounts[normalizedType], normalizedType === "demo" ? 10000 : 0);

    const response = {
      clerkId: String(clerkId),
      accountType: normalizedType,
      balance: account.balance,
      account,
      accounts: {
        demo: normalizeAccount(accounts.demo, 10000),
        real: normalizeAccount(accounts.real, 0),
      },
      wallet: {
        balance: account.balance,
        transactions: account.transactions,
      },
    };

    return res.status(200).json(response);
  } catch (error) {
    console.error("Get account error:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

accountRouter.get("/account/stream", (req, res) => {
  const { clerkId } = req.query;

  if (!clerkId) {
    return res.status(400).json({ message: "Missing clerkId" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 10000\n\n");

  addSseClient(req, res, String(clerkId));
});

// Retired: used to mint/remove arbitrary balance for any clerkId with zero verification. Demo
// balance top-ups now go through POST /account/set-demo-balance instead.
accountRouter.post("/account/fund", retiredEndpoint("POST /account/set-demo-balance (demo) or a real crypto deposit (real)"));

accountRouter.post("/account/set-demo-balance", async (req, res) => {
  try {
    const { clerkId, amount, description } = req.body;

    if (!clerkId) {
      return res.status(400).json({ message: "Missing clerkId" });
    }

    if (!Number.isFinite(Number(amount))) {
      return res.status(400).json({ message: "Invalid amount" });
    }

    const parsedAmount = Number(amount);
    if (parsedAmount < 0) {
      return res.status(400).json({ message: "Balance cannot be negative" });
    }

    const Users = await getUsersCollection();
    const user = await ensureUserRecord(String(clerkId));
    const accounts = user.accounts || getDefaultAccounts();
    const currentAccount = normalizeAccount(accounts.demo, 10000);

    const transaction = {
      type: "set",
      category: "wallet",
      amount: parsedAmount,
      balanceBefore: currentAccount.balance,
      balanceAfter: parsedAmount,
      description: description || "Demo balance set by user",
      createdAt: new Date(),
    };

    const nextAccounts = {
      ...accounts,
      demo: {
        ...currentAccount,
        balance: parsedAmount,
        transactions: [...currentAccount.transactions, transaction],
        updatedAt: new Date(),
      },
    };

    const updatedUser = await Users.findOneAndUpdate(
      { clerkId: String(clerkId) },
      {
        $set: {
          accounts: nextAccounts,
          "wallet.balance": parsedAmount,
          "wallet.transactions": [...((user.wallet?.transactions || [])), transaction],
        },
      },
      { returnDocument: "after" }
    );

    broadcastBalanceUpdate(String(clerkId), {
      balance: parsedAmount,
      accountType: "demo",
    });

    return res.status(200).json({
      message: "Demo balance updated",
      clerkId: String(clerkId),
      balance: parsedAmount,
      account: nextAccounts.demo,
      wallet: {
        balance: parsedAmount,
        transactions: [...((updatedUser.wallet?.transactions || [])), transaction],
      },
    });
  } catch (error) {
    console.error("Set demo balance error:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

export default accountRouter;
