import { getAuth } from "@clerk/express";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60_000;

// In-memory, per-IP brute-force guard for the admin header-code path — the only credential an
// attacker could ever try to guess (a Clerk session can't be forged). Shared across all admin
// routes so an attacker can't dodge the limit by spreading guesses across different endpoints.
// Single-process only: fine for this one Render instance, would need a shared store (e.g. Redis)
// if this backend ever scales horizontally.
const attemptsByIp = new Map();

function isLockedOut(ip) {
  const entry = attemptsByIp.get(ip);
  return Boolean(entry?.lockedUntil && entry.lockedUntil > Date.now());
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const entry = attemptsByIp.get(ip) || { count: 0, windowStart: now, lockedUntil: 0 };
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
  attemptsByIp.set(ip, entry);
}

function clearAttempts(ip) {
  attemptsByIp.delete(ip);
}

// Verified Clerk identity matching the configured admin, OR the shared secret code presented via
// a dedicated header — never a clerkId trusted from the request body (that was the actual
// vulnerability: a non-secret identifier let anyone impersonate the admin without knowing
// anything secret at all). No hardcoded fallback: if TRIOMAC60_ADMIN_CODE isn't set, the
// header-code path is simply unavailable rather than defaulting to a known-weak secret.
//
// clerkMiddleware() must run earlier in the request chain for getAuth() to return anything — it
// never blocks on its own, so this still works for the header-code path with no Clerk session at
// all (the admin panel today doesn't require one, see middleware.js in the frontend).
export function requireAdminAccess(req, res, next) {
  const ip = req.ip;
  if (isLockedOut(ip)) {
    return res.status(429).json({ success: false, error: "Too many failed admin attempts — try again later" });
  }

  const { userId } = getAuth(req);
  const adminClerkId = process.env.TRIOMAC60_ADMIN_CLERK_ID;
  if (adminClerkId && userId === adminClerkId) {
    clearAttempts(ip);
    return next();
  }

  const headerCode = req.get("x-admin-code");
  const expectedCode = process.env.TRIOMAC60_ADMIN_CODE;
  if (expectedCode && headerCode === expectedCode) {
    clearAttempts(ip);
    return next();
  }

  recordFailedAttempt(ip);
  return res.status(403).json({ success: false, error: "Admin access required" });
}
