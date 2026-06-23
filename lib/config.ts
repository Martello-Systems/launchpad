// Centralized runtime configuration, read from environment variables.

export function getMilestoneThreshold(): number {
  const raw = process.env.REFERRAL_MILESTONE;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

export function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "http://localhost:3000";
}

export function getEmailFrom(): string {
  return process.env.EMAIL_FROM || "Launchpad <onboarding@resend.dev>";
}

export function getAdminToken(): string | undefined {
  return process.env.ADMIN_TOKEN || undefined;
}

// Number of waitlist positions a successful referral moves the referrer up.
// Documented rule (see lib/waitlist.ts): each verified referral improves the
// referrer's effective position by this many slots, floored at position 1.
export const POSITION_BOOST_PER_REFERRAL = 1;

export function referralLink(code: string): string {
  return `${getAppUrl()}/?ref=${encodeURIComponent(code)}`;
}

// ---- Embed CSP (frame-ancestors) ----
//
// The embeddable widget (/embed and /embed.js) is meant to be iframed by other
// sites. Which origins may embed it is configurable via EMBED_ALLOWED_ORIGINS,
// a comma/space-separated list of origins, e.g.:
//   EMBED_ALLOWED_ORIGINS="https://acme.com https://www.acme.com"
// Special values:
//   - unset / empty  -> "'self'" (safe default: only this deployment may frame)
//   - "*"            -> any origin (wide open; opt-in only)
// We emit a Content-Security-Policy with a single frame-ancestors directive so
// it works in modern browsers (and supersedes the legacy X-Frame-Options).

/** Parse EMBED_ALLOWED_ORIGINS into the frame-ancestors source list. */
export function embedFrameAncestors(): string {
  const raw = (process.env.EMBED_ALLOWED_ORIGINS || "").trim();
  if (!raw) return "'self'";
  if (raw === "*") return "*";
  const origins = raw
    .split(/[\s,]+/)
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length === 0) return "'self'";
  // Always include 'self' so the deployment can preview its own widget, unless
  // the operator already listed it explicitly.
  const hasSelf = origins.some((o) => o === "'self'");
  const list = hasSelf ? origins : ["'self'", ...origins];
  return list.join(" ");
}

/** Full Content-Security-Policy value for embeddable routes. */
export function embedCsp(): string {
  return `frame-ancestors ${embedFrameAncestors()}`;
}

/** Whether to enable email double-opt-in verification. Defaults to true. */
export function isEmailVerificationEnabled(): boolean {
  const raw = (process.env.REQUIRE_EMAIL_VERIFICATION || "").trim().toLowerCase();
  if (raw === "" ) return true; // safe default: verification on
  return !(raw === "false" || raw === "0" || raw === "no" || raw === "off");
}
