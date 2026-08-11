import { getAuth } from "@clerk/express";

// @clerk/express's own requireAuth() is deprecated in this version and redirects unauthenticated
// requests to a sign-in URL — the wrong behavior for a JSON API (a frontend fetch() call follows
// the redirect silently and gets an unexpected 200 from whatever "/" returns, instead of a clean
// error it can catch and show). This is the pattern Clerk's own docs recommend instead:
// clerkMiddleware() (mounted globally in app.js) + getAuth(req) + a manual 401.
export function requireAuthJson(req, res, next) {
  const { userId } = getAuth(req);
  if (!userId) {
    return res.status(401).json({ success: false, error: "Authentication required" });
  }
  next();
}
