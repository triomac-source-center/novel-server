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
// A document has a properly-shaped account sub-object once it has a numeric balance and an array
// of transactions — that's all normalizeAccount ever guarantees, so it's also the exact condition
// under which re-running it would be a no-op.
const hasValidAccount = (account) => typeof account?.balance === "number" && Array.isArray(account?.transactions);

// TEMPORARY — counts how many times ensureUserRecord actually reaches the $set write path, so a
// verification endpoint can prove a normal repeated read no longer triggers a write. Will be
// reverted together with the endpoint that reads it.
export const debugCounters = { ensureUserRecordWrites: 0 };

export const ensureUserRecord = async (clerkId, profile = {}) => {
  const Users = getUsersCollection();
  const defaults = getDefaultAccounts();
  const fallbackEmail = `${clerkId}@no-email.triomac60.local`;
  const fallbackUsername = `user_${clerkId}`;

  const existing = await Users.findOne({ clerkId });
  if (existing) {
    const currentAccounts = existing.accounts || {};
    const needsAccountsBackfill = !hasValidAccount(currentAccounts.demo) || !hasValidAccount(currentAccounts.real);
    const needsEmailBackfill = !existing.email;
    const needsUsernameBackfill = !existing.username;
    const needsWalletBalanceBackfill = existing.wallet?.balance === undefined || existing.wallet?.balance === null;

    if (!needsAccountsBackfill && !needsEmailBackfill && !needsUsernameBackfill && !needsWalletBalanceBackfill) {
      // Nothing to backfill on this document — return it as-is instead of writing back a snapshot
      // of data that's already correct. This function used to run an unconditional $set on every
      // call (i.e. on every GET /account, since the frontend polls that every 5s), which meant a
      // read taken before a concurrent balance update could commit its stale copy back AFTER that
      // update landed, silently erasing it. Skipping the write whenever nothing is actually broken
      // removes that race instead of just narrowing it.
      return existing;
    }

    const normalizedReal = hasValidAccount(currentAccounts.real) ? currentAccounts.real : normalizeAccount(currentAccounts.real, defaults.real.balance);

    debugCounters.ensureUserRecordWrites += 1; // TEMPORARY, see declaration above

    const update = {
      $set: {
        // Only backfill the specific sub-account that's actually missing/malformed — never
        // overwrite the other one, which may be mid-update elsewhere.
        ...(!hasValidAccount(currentAccounts.demo) ? { "accounts.demo": normalizeAccount(currentAccounts.demo, defaults.demo.balance) } : {}),
        ...(!hasValidAccount(currentAccounts.real) ? { "accounts.real": normalizedReal } : {}),
        ...(needsEmailBackfill ? { email: profile.email || fallbackEmail } : {}),
        ...(needsUsernameBackfill ? { username: profile.username || fallbackUsername } : {}),
        ...(needsWalletBalanceBackfill ? { "wallet.balance": normalizedReal.balance } : {}),
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

// Same pattern already used by creditOwner() in cluster_route.js / authorship_block_route.js
// (kept as their own local copies there — this is a third, shared version for new callers like
// the deposit-crediting script, instead of duplicating it a third time).
export const creditUserBalance = async (clerkId, amount, description, session, meta = {}) => {
  const Users = getUsersCollection();
  const user = await Users.findOne({ clerkId }, { session });
  if (!user) throw new Error(`User ${clerkId} not found`);

  const account = normalizeAccount(user.accounts?.real, 0);
  const before = account.balance;
  const after = before + amount;
  const transaction = {
    type: "credit",
    category: meta.category ?? "deposit",
    amount,
    balanceBefore: before,
    balanceAfter: after,
    description,
    createdAt: new Date(),
  };

  const accounts = {
    ...(user.accounts || {}),
    real: { ...account, balance: after, transactions: [...account.transactions, transaction], updatedAt: new Date() },
  };

  await Users.findOneAndUpdate(
    { clerkId },
    {
      $set: {
        accounts,
        "wallet.balance": after,
        "wallet.transactions": [...(user.wallet?.transactions || []), transaction],
      },
    },
    { session }
  );

  return after;
};

// Unlike creditUserBalance (read-then-write), a debit has real double-spend risk under
// concurrency, so the balance check and the decrement happen in one atomic operation: the filter
// itself requires accounts.real.balance >= amount, so if two concurrent debits race, the second
// one to reach Mongo simply fails to match any document (already-decremented balance is now below
// amount) instead of both succeeding against a stale read. Throws "Insufficient balance" when that
// happens, which the caller (withdrawal route) is expected to catch and turn into a 4xx.
export const debitUserBalance = async (clerkId, amount, description, session, meta = {}) => {
  const Users = getUsersCollection();
  const updated = await Users.findOneAndUpdate(
    { clerkId, "accounts.real.balance": { $gte: amount } },
    { $inc: { "accounts.real.balance": -amount, "wallet.balance": -amount } },
    { session, returnDocument: "after" }
  );
  if (!updated) {
    throw new Error("Insufficient balance");
  }

  const after = updated.accounts.real.balance;
  const before = after + amount;
  const transaction = {
    type: "debit",
    category: meta.category ?? "withdrawal",
    amount,
    balanceBefore: before,
    balanceAfter: after,
    description,
    createdAt: new Date(),
  };

  await Users.updateOne(
    { clerkId },
    { $push: { "accounts.real.transactions": transaction, "wallet.transactions": transaction } },
    { session }
  );

  return after;
};
