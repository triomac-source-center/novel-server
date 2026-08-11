import mongoose from "mongoose";

const { Schema } = mongoose;

// One document per named lock (e.g. "sweep-deposits"). _id doubles as the lock name — see
// lib/cron-lock.js for the acquire/release logic that relies on _id's uniqueness for atomicity.
const CronLockSchema = new Schema({
  _id: { type: String },
  lockedAt: { type: Date, required: true },
  // Set once a "this lock looks stuck" alert has been sent for the CURRENT holder, so repeated
  // skip checks during the same stuck episode don't spam the same alert — reset to false every
  // time the lock is legitimately (re-)acquired.
  staleAlertSent: { type: Boolean, default: false },
});

const CronLock = mongoose.model("cron_locks", CronLockSchema);

export default CronLock;
