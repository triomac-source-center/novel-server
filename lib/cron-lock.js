// Simple DB-backed mutual-exclusion lock for cron scripts that run as fresh, stateless Render Cron
// Job containers each time — there's no persistent in-process memory to hold a lock across runs,
// so it has to live in Mongo instead.
import CronLock from "../models/cron_lock_model.js";

const MONGO_DUPLICATE_KEY_ERROR = 11000;

// Atomically acquires the named lock: succeeds if no lock document exists yet, OR if the existing
// one is older than staleMs (a previous run crashed/hung without releasing it). The filter's $or
// is what makes this atomic — if neither condition holds (a fresh lock is genuinely held by
// another run), the upsert has nothing to match and tries to INSERT a new doc with the same _id,
// which Mongo rejects as a duplicate key. That's not a real error here, just "lock unavailable
// right now" — caught below and reported as a clean false.
export async function tryAcquireLock(name, staleMs) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - staleMs);
  try {
    await CronLock.findOneAndUpdate(
      { _id: name, $or: [{ lockedAt: { $exists: false } }, { lockedAt: { $lt: staleBefore } }] },
      { $set: { lockedAt: now, staleAlertSent: false } },
      { upsert: true }
    );
    return true;
  } catch (error) {
    if (error.code === MONGO_DUPLICATE_KEY_ERROR) return false;
    throw error;
  }
}

export async function releaseLock(name) {
  await CronLock.deleteOne({ _id: name });
}

// Called when acquisition fails, to tell a legitimately-still-running holder apart from a dead one
// that never released. Returns how long the lock has been held (ms) the first time it crosses
// warnAfterMs for this holder, or null otherwise (either not old enough yet, or already reported
// once for this same holder — see staleAlertSent).
export async function checkStuckLock(name, warnAfterMs) {
  const lock = await CronLock.findById(name);
  if (!lock) return null; // released between our failed acquire and this check — not stuck after all
  const heldForMs = Date.now() - lock.lockedAt.getTime();
  if (heldForMs < warnAfterMs || lock.staleAlertSent) return null;
  await CronLock.updateOne({ _id: name }, { $set: { staleAlertSent: true } });
  return heldForMs;
}
