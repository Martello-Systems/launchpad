// Mailer interface so the core logic never depends on a concrete provider.
// Tests inject a mock; production uses the Resend-backed implementation.

import { getAppUrl, getEmailFrom, referralLink } from "./config";
import { theme } from "../theme.config";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<{ id: string | null }>;
}

/**
 * Console mailer, used when no RESEND_API_KEY is present (local dev/test).
 * Logs the message instead of sending. Never throws.
 */
export class ConsoleMailer implements Mailer {
  async send(msg: MailMessage): Promise<{ id: string | null }> {
    // eslint-disable-next-line no-console
    console.log(`[ConsoleMailer] -> ${msg.to}: ${msg.subject}`);
    return { id: null };
  }
}

/**
 * Resend-backed mailer. Reads RESEND_API_KEY lazily so importing this module
 * never requires the key to be present (important for tests/build).
 */
export class ResendMailer implements Mailer {
  private apiKey: string;
  private from: string;

  constructor(apiKey: string, from: string) {
    this.apiKey = apiKey;
    this.from = from;
  }

  async send(msg: MailMessage): Promise<{ id: string | null }> {
    // Lazy import keeps `resend` out of the test/path when unused.
    const { Resend } = await import("resend");
    const resend = new Resend(this.apiKey);
    const { data, error } = await resend.emails.send({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    });
    if (error) {
      throw new Error(`Resend send failed: ${error.message}`);
    }
    return { id: data?.id ?? null };
  }
}

/**
 * Factory: returns ResendMailer when RESEND_API_KEY is set, otherwise the
 * ConsoleMailer. This is what the API routes use.
 */
export function getDefaultMailer(): Mailer {
  const key = process.env.RESEND_API_KEY;
  if (key && key.trim().length > 0) {
    return new ResendMailer(key, getEmailFrom());
  }
  return new ConsoleMailer();
}

// ---- Message builders (pure; easy to unit test) ----

export function buildConfirmationEmail(params: {
  email: string;
  referralCode: string;
  position: number;
}): MailMessage {
  const link = referralLink(params.referralCode);
  const subject = "You're on the waitlist!";
  const text = `Welcome! You're #${params.position} on the waitlist.

Share your referral link to move up:
${link}

Your code: ${params.referralCode}`;
  const html = `<div style="font-family:sans-serif;max-width:480px">
  <h2>You're on the waitlist!</h2>
  <p>You're currently <strong>#${params.position}</strong>.</p>
  <p>Share your referral link to move up the list:</p>
  <p><a href="${link}">${link}</a></p>
  <p style="color:#666">Your code: <code>${params.referralCode}</code></p>
</div>`;
  return { to: params.email, subject, html, text };
}

export function verifyLink(token: string): string {
  return `${getAppUrl()}/api/verify?token=${encodeURIComponent(token)}`;
}

export function buildVerificationEmail(params: {
  email: string;
  verifyToken: string;
}): MailMessage {
  const link = verifyLink(params.verifyToken);
  const subject = "Confirm your spot on the waitlist";
  const text = `Almost there! Confirm your email to lock in your spot on the waitlist.

Click to confirm:
${link}

If you didn't request this, you can ignore this email.`;
  const html = `<div style="font-family:sans-serif;max-width:480px">
  <h2>Confirm your email</h2>
  <p>Almost there! Click below to lock in your spot on the waitlist.</p>
  <p><a href="${link}" style="display:inline-block;background:${theme.email.accent};color:${theme.email.accentFg};padding:10px 18px;border-radius:6px;text-decoration:none">Confirm my spot</a></p>
  <p style="color:#666;font-size:13px">Or paste this link: <br><a href="${link}">${link}</a></p>
  <p style="color:#999;font-size:12px">If you didn't request this, you can ignore this email.</p>
</div>`;
  return { to: params.email, subject, html, text };
}

/**
 * Sent when someone tries to sign up with an email that is ALREADY verified and
 * on the list. It carries no position or new code (nothing to leak); it just
 * reassures the recipient. This is what lets the signup endpoint return an
 * identical response whether or not the email already existed (anti-enumeration)
 * without going silent on a legitimate "did my signup work?" retry.
 */
export function buildAlreadyOnListEmail(params: { email: string }): MailMessage {
  const subject = "You're already on the waitlist";
  const text = `Good news: this email is already on the waitlist, so there's nothing more to do.

If you didn't just try to sign up again, you can safely ignore this email.`;
  const html = `<div style="font-family:sans-serif;max-width:480px">
  <h2>You're already on the waitlist</h2>
  <p>This email is already confirmed and on the list, so there's nothing more to do.</p>
  <p style="color:#999;font-size:12px">If you didn't just try to sign up again, you can ignore this email.</p>
</div>`;
  return { to: params.email, subject, html, text };
}

export function buildMilestoneEmail(params: {
  email: string;
  referralCount: number;
  position: number;
}): MailMessage {
  const subject = `You've referred ${params.referralCount} people!`;
  const text = `Nice work. ${params.referralCount} referrals so far. You're now #${params.position} on the waitlist. Keep sharing!`;
  const html = `<div style="font-family:sans-serif;max-width:480px">
  <h2>Milestone reached!</h2>
  <p>You've referred <strong>${params.referralCount}</strong> people.</p>
  <p>You're now <strong>#${params.position}</strong> on the waitlist. Keep sharing!</p>
</div>`;
  return { to: params.email, subject, html, text };
}
