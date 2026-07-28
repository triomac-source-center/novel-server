import mongoose from "mongoose";

export const getUsersCollection = () => mongoose.connection.collection("users");

export const getDefaultAccounts = () => ({
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

export const normalizeAccount = (account = {}, fallbackBalance = 0) => ({
  balance: Number(account.balance ?? fallbackBalance),
  currency: account.currency || "USD",
  transactions: Array.isArray(account.transactions) ? account.transactions : [],
  updatedAt: account.updatedAt || new Date(),
});

// Clerk handles sign-up/sign-in, but a user's wallet document only gets created here on first
// use of an account-related endpoint. If the Clerk webhook never fired (misconfigured, or the
// account predates it) this still transparently creates the record instead of 404ing.
export const ensureUserRecord = async (clerkId) => {
  const Users = getUsersCollection();
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
