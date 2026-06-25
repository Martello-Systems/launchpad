// Shared display formatters.

/**
 * Mask an email for public display, e.g. `a***@domain.com`. Best-effort
 * obfuscation for the public leaderboard, NOT anonymization (see README
 * "Limitations"). Centralized here so the server route and the server-rendered
 * page stay byte-for-byte identical.
 */
export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  const head = user.slice(0, 1);
  return `${head}${"*".repeat(Math.max(2, user.length - 1))}@${domain}`;
}
