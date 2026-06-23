import { getAdminToken } from "./config";

/**
 * Verify an admin bearer token from a request's Authorization header (or an
 * `x-admin-token` header). Returns true only when ADMIN_TOKEN is configured AND
 * matches. If ADMIN_TOKEN is unset, access is denied (fail closed).
 */
export function isAdminAuthorized(headers: Headers): boolean {
  const configured = getAdminToken();
  if (!configured) return false;

  const auth = headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : undefined;
  const direct = headers.get("x-admin-token")?.trim();

  const provided = bearer || direct;
  if (!provided) return false;

  // Constant-time-ish comparison.
  return timingSafeEqual(provided, configured);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
