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
