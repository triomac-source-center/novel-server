const FALLBACK_ADMIN_CODE = "larson477";

export function isAdmin(clerkId, adminCode) {
  const matchesClerkId = Boolean(process.env.TRIOMAC60_ADMIN_CLERK_ID) && clerkId === process.env.TRIOMAC60_ADMIN_CLERK_ID;
  const expectedCode = process.env.TRIOMAC60_ADMIN_CODE || FALLBACK_ADMIN_CODE;
  const matchesCode = Boolean(adminCode) && adminCode === expectedCode;
  return matchesClerkId || matchesCode;
}
