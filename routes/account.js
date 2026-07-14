import express from "express";
import mongoose from "mongoose";

const accountRouter = express.Router();

const sseClients = [];

const getUsersCollection = () => mongoose.connection.collection("users");

const sendSseEvent = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const addSseClient = (req, res, clerkId) => {
  const client = { req, res, clerkId };
  sseClients.push(client);

  req.on("close", () => {
    const index = sseClients.indexOf(client);
    if (index !== -1) {
      sseClients.splice(index, 1);
    }
  });
};

const broadcastBalanceUpdate = (clerkId, data) => {
  sseClients.slice().forEach((client) => {
    if (client.clerkId !== clerkId) return;
    try {
      sendSseEvent(client.res, "balance-update", data);
    } catch (error) {
      const index = sseClients.indexOf(client);
      if (index !== -1) {
        sseClients.splice(index, 1);
      }
    }
  });
};

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

const normalizeAccount = (account = {}, fallbackBalance = 0) => ({
  balance: Number(account.balance ?? fallbackBalance),
  currency: account.currency || "USD",
  transactions: Array.isArray(account.transactions) ? account.transactions : [],
  updatedAt: account.updatedAt || new Date(),
});

const ensureUserRecord = async (clerkId) => {
  const Users = await getUsersCollection();
  const defaults = getDefaultAccounts();

  const existing = await Users.findOne({ clerkId });
  if (existing) {
    const currentAccounts = existing.accounts || {};
    const mergedAccounts = {
      demo: normalizeAccount(currentAccounts.demo, defaults.demo.balance),
      real: normalizeAccount(currentAccounts.real, defaults.real.balance),
    };

    const update = {
      $set: {
        accounts: mergedAccounts,
        "wallet.balance": existing.wallet?.balance ?? mergedAccounts.real.balance,
      },
      $setOnInsert: {
        clerkId,
        createdAt: new Date(),
      },
    };

    const updated = await Users.findOneAndUpdate({ clerkId }, update, {
      upsert: true,
      returnDocument: "after",
    });

    return updated;
  }

  const created = await Users.findOneAndUpdate(
    { clerkId },
    {
      $setOnInsert: {
        clerkId,
        accounts: defaults,
        wallet: {
          balance: defaults.real.balance,
          transactions: [],
        },
        createdAt: new Date(),
      },
    },
    {
      upsert: true,
      returnDocument: "after",
    }
  );

  return created;
};

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

accountRouter.post("/account/fund", async (req, res) => {
  try {
    const { clerkId, amount, type = "real", description } = req.body;

    if (!clerkId) {
      return res.status(400).json({ message: "Missing clerkId" });
    }

    if (!Number.isFinite(Number(amount)) || Number(amount) === 0) {
      return res.status(400).json({ message: "Invalid amount" });
    }

    const normalizedType = type === "demo" ? "demo" : "real";
    const parsedAmount = Number(amount);
    const Users = await getUsersCollection();
    const user = await ensureUserRecord(String(clerkId));
    const accounts = user.accounts || getDefaultAccounts();
    const currentAccount = normalizeAccount(accounts[normalizedType], normalizedType === "demo" ? 10000 : 0);
    const nextBalance = currentAccount.balance + parsedAmount;

    if (nextBalance < 0) {
      return res.status(400).json({ message: "Insufficient balance" });
    }

    const transaction = {
      type: parsedAmount >= 0 ? "credit" : "debit",
      amount: Math.abs(parsedAmount),
      balanceBefore: currentAccount.balance,
      balanceAfter: nextBalance,
      description: description || `${normalizedType} account update`,
      createdAt: new Date(),
    };

    const updatedTransactions = [...currentAccount.transactions, transaction];
    const nextAccounts = {
      ...accounts,
      [normalizedType]: {
        ...currentAccount,
        balance: nextBalance,
        transactions: updatedTransactions,
        updatedAt: new Date(),
      },
    };

    const updatedUser = await Users.findOneAndUpdate(
      { clerkId: String(clerkId) },
      {
        $set: {
          accounts: nextAccounts,
          "wallet.balance": nextBalance,
          "wallet.transactions": [...((user.wallet?.transactions || [])), transaction],
        },
      },
      { returnDocument: "after" }
    );

    broadcastBalanceUpdate(String(clerkId), {
      balance: nextBalance,
      accountType: normalizedType,
    });

    return res.status(200).json({
      message: "Account updated",
      clerkId: String(clerkId),
      accountType: normalizedType,
      balance: nextBalance,
      account: nextAccounts[normalizedType],
      wallet: {
        balance: nextBalance,
        transactions: [...((updatedUser.wallet?.transactions || [])), transaction],
      },
    });
  } catch (error) {
    console.error("Fund account error:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

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
