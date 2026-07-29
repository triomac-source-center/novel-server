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
//
// The `users` collection has UNIQUE indexes on both `email` and `username` (from the frontend's
// Mongoose model) and neither is sparse. A brand-new document created here rarely has either
// available, and leaving them missing/null is NOT safe — MongoDB's unique index treats every doc
// missing the field as sharing the same null value, so only the very first such user can ever be
// created; every subsequent one fails with a "DuplicateKey" 500. Always fall back to a
// synthetic-but-guaranteed-unique value (derived from clerkId, which Clerk guarantees is unique)
// for BOTH fields when no real one is supplied.
export const ensureUserRecord = async (clerkId, profile = {}) => {
  const Users = getUsersCollection();
  const defaults = getDefaultAccounts();
  const fallbackEmail = `${clerkId}@no-email.triomac60.local`;
  const fallbackUsername = `user_${clerkId}`;

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
        // Backfill missing unique fields on an already-broken record (created before this fix)
        // so it stops colliding with other users on the next write.
        ...(!existing.email ? { email: profile.email || fallbackEmail } : {}),
        ...(!existing.username ? { username: profile.username || fallbackUsername } : {}),
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
        email: profile.email || fallbackEmail,
        username: profile.username || fallbackUsername,
        firstName: profile.firstName || null,
        lastName: profile.lastName || null,
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
