// Core, framework-agnostic waitlist logic.
//
// POSITION RULE (documented + tested):
//   - On signup, a person is appended to the end of the list. Their base
//     position equals the count of existing signups + 1 (1-indexed).
//   - A "successful referral" = someone signs up using your referral code.
//     Each successful referral boosts the referrer's position UP by
//     POSITION_BOOST_PER_REFERRAL slots. Effective position is therefore:
//         effectivePosition = max(1, basePosition - referralCount * BOOST)
//   - basePosition is stored at signup and never mutated; the boost is applied
//     on read (getEntry / leaderboard) so the rule stays deterministic and the
//     stored value remains an audit trail of join order.

import type { PrismaClient, Waitlist } from "@prisma/client";
import { generateReferralCode } from "./referral-code";
import {
  POSITION_BOOST_PER_REFERRAL,
  getMilestoneThreshold,
  getVerifyTokenTtlMs,
  isEmailVerificationEnabled,
} from "./config";
import {
  buildAlreadyOnListEmail,
  buildConfirmationEmail,
  buildMilestoneEmail,
  buildVerificationEmail,
  type Mailer,
} from "./mailer";

/**
 * Mint a fresh verification token and its expiry (or null when verification is
 * off or TTL is disabled). Centralized so signup and re-send stay consistent.
 */
function newVerificationToken(): { token: string; expiresAt: Date | null } {
  const token = generateReferralCode(24);
  const ttlMs = getVerifyTokenTtlMs();
  const expiresAt = ttlMs > 0 ? new Date(Date.now() + ttlMs) : null;
  return { token, expiresAt };
}

/** A pending entry's token is usable if present and not past its expiry. */
function tokenIsLive(entry: {
  verifyToken: string | null;
  verifyTokenExpiresAt: Date | null;
}): boolean {
  if (!entry.verifyToken) return false;
  if (!entry.verifyTokenExpiresAt) return true; // no TTL set => never expires
  return entry.verifyTokenExpiresAt.getTime() > Date.now();
}

export class WaitlistError extends Error {
  code: "DUPLICATE_EMAIL" | "INVALID_EMAIL" | "NOT_FOUND" | "INVALID_TOKEN";
  constructor(code: WaitlistError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "WaitlistError";
  }
}

export interface SignupResult {
  id: string;
  email: string;
  referralCode: string;
  basePosition: number;
  position: number; // effective (boosted) position
  referredById: string | null;
  verified: boolean;
  /** True when a verification email was issued and the entry is pending. */
  pendingVerification: boolean;
  createdAt: Date;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function effectivePosition(basePosition: number, referralCount: number): number {
  return Math.max(1, basePosition - referralCount * POSITION_BOOST_PER_REFERRAL);
}

async function generateUniqueCode(prisma: PrismaClient): Promise<string> {
  // Retry on the astronomically rare collision.
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = generateReferralCode(8);
    const existing = await prisma.waitlist.findUnique({
      where: { referralCode: code },
      select: { id: true },
    });
    if (!existing) return code;
  }
  // Fall back to a longer code if we somehow keep colliding.
  return generateReferralCode(12);
}

/**
 * Sign someone up. Creates the entry, generates a unique referral code,
 * assigns the next base position, and (if referredByCode is valid) attributes
 * the referral. Optionally sends a confirmation email via the injected mailer.
 *
 * Throws WaitlistError("DUPLICATE_EMAIL") if the email is already on the list.
 */
export async function signup(
  prisma: PrismaClient,
  input: { email: string; referredByCode?: string | null },
  opts: { mailer?: Mailer; sendEmail?: boolean } = {}
): Promise<SignupResult> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) {
    throw new WaitlistError("INVALID_EMAIL", "A valid email is required.");
  }

  // Resolve referrer (if any) before the transaction.
  let referrer: Waitlist | null = null;
  if (input.referredByCode) {
    referrer = await prisma.waitlist.findUnique({
      where: { referralCode: input.referredByCode.trim() },
    });
    // A bad/unknown code is silently ignored (no attribution) rather than
    // failing the signup: the person still wants to join.
  }

  // Pre-existing email check for a clean error (the unique constraint is the
  // real guard against races).
  const dup = await prisma.waitlist.findUnique({ where: { email }, select: { id: true } });
  if (dup) {
    throw new WaitlistError("DUPLICATE_EMAIL", "That email is already on the waitlist.");
  }

  const code = await generateUniqueCode(prisma);

  // Double-opt-in: when verification is enabled, the entry starts unverified
  // with a single-use token and we email a verify link. Referral credit only
  // counts AFTER verification (see referralCount / leaderboard). When disabled,
  // entries are created verified and the confirmation email fires immediately.
  const verificationEnabled = isEmailVerificationEnabled();
  const { token: verifyToken, expiresAt: verifyTokenExpiresAt } = verificationEnabled
    ? newVerificationToken()
    : { token: null, expiresAt: null };

  let created: Waitlist;
  try {
    created = await prisma.$transaction(async (tx) => {
      const count = await tx.waitlist.count();
      const basePosition = count + 1;
      return tx.waitlist.create({
        data: {
          email,
          referralCode: code,
          position: basePosition,
          referredById: referrer ? referrer.id : null,
          verified: !verificationEnabled,
          verifyToken,
          verifyTokenExpiresAt,
          verifiedAt: verificationEnabled ? null : new Date(),
        },
      });
    });
  } catch (e: unknown) {
    // Handle the unique-constraint race (P2002) as a duplicate.
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code?: string }).code === "P2002"
    ) {
      throw new WaitlistError("DUPLICATE_EMAIL", "That email is already on the waitlist.");
    }
    throw e;
  }

  // Email step (best-effort; failures must not break signup).
  if (opts.sendEmail && opts.mailer) {
    try {
      if (verificationEnabled && created.verifyToken) {
        // Send the verify link. Confirmation + milestone fire on verify.
        await opts.mailer.send(
          buildVerificationEmail({
            email: created.email,
            verifyToken: created.verifyToken,
          })
        );
      } else {
        // Verification disabled: send the welcome confirmation right away.
        await opts.mailer.send(
          buildConfirmationEmail({
            email: created.email,
            referralCode: created.referralCode,
            position: created.position,
          })
        );
        // And credit the referrer's milestone immediately (entry is verified).
        if (referrer) {
          await maybeSendMilestone(prisma, referrer.id, opts.mailer);
        }
      }
    } catch {
      /* swallow: email is not critical to the signup transaction */
    }
  }

  return {
    id: created.id,
    email: created.email,
    referralCode: created.referralCode,
    basePosition: created.position,
    position: created.position, // brand-new signup has 0 (verified) referrals
    referredById: created.referredById,
    verified: created.verified,
    pendingVerification: verificationEnabled,
    createdAt: created.createdAt,
  };
}

/**
 * Confirm a signup via its verification token. Marks the entry verified,
 * clears the single-use token, then (best-effort) sends the welcome
 * confirmation email and credits the referrer's milestone, because referral
 * credit only counts verified signups.
 *
 * Throws WaitlistError("INVALID_TOKEN") for an unknown token. Verifying an
 * already-verified entry (e.g. a double-submitted confirm form, or a re-clicked
 * link where the token still matches) is idempotent: it returns
 * alreadyVerified=true and does NOT re-send emails.
 *
 * SINGLE-USE: the token is "single-use" in the sense that it can only ever flip
 * an entry from pending -> verified once (the side effects — welcome + milestone
 * emails — fire exactly once). We deliberately keep the token string on the row
 * after verifying so a second confirmation request is recognized and handled
 * idempotently instead of looking like an unknown/expired token. We clear the
 * EXPIRY on verify so the time-limit no longer applies to a confirmed entry.
 */
export async function verifyEmail(
  prisma: PrismaClient,
  token: string,
  opts: { mailer?: Mailer; sendEmail?: boolean } = {}
): Promise<{ id: string; email: string; alreadyVerified: boolean }> {
  const trimmed = (token || "").trim();
  if (!trimmed) {
    throw new WaitlistError("INVALID_TOKEN", "A verification token is required.");
  }

  const entry = await prisma.waitlist.findUnique({ where: { verifyToken: trimmed } });
  if (!entry) {
    throw new WaitlistError("INVALID_TOKEN", "This verification link is invalid or has expired.");
  }

  if (entry.verified) {
    // Token still present but already verified: treat as idempotent success.
    return { id: entry.id, email: entry.email, alreadyVerified: true };
  }

  // Expired token: reject gracefully, exactly like an unknown token. The pending
  // entry stays put; the user can sign up again to be issued a fresh link.
  if (!tokenIsLive(entry)) {
    throw new WaitlistError("INVALID_TOKEN", "This verification link is invalid or has expired.");
  }

  const updated = await prisma.waitlist.update({
    where: { id: entry.id },
    data: {
      verified: true,
      verifiedAt: new Date(),
      // Keep verifyToken so a repeat confirmation is handled idempotently (see
      // the `entry.verified` short-circuit above); only the expiry is cleared.
      verifyTokenExpiresAt: null,
    },
  });

  if (opts.sendEmail && opts.mailer) {
    try {
      await opts.mailer.send(
        buildConfirmationEmail({
          email: updated.email,
          referralCode: updated.referralCode,
          position: updated.position,
        })
      );
      // Now that this signup is verified, the referrer may have hit a milestone.
      if (updated.referredById) {
        await maybeSendMilestone(prisma, updated.referredById, opts.mailer);
      }
    } catch {
      /* swallow: email is not critical to verification */
    }
  }

  return { id: updated.id, email: updated.email, alreadyVerified: false };
}

/**
 * Handle a signup attempt for an email that is ALREADY on the list, WITHOUT
 * disclosing that it exists. This is what lets POST /api/signup return a
 * response identical to a brand-new signup (anti-enumeration): the route calls
 * this on a duplicate and then returns the same generic "check your inbox" body.
 *
 * Best-effort emails (never throws):
 *   - entry still pending with a live token  -> resend that verification link
 *   - entry pending but token missing/expired -> mint a fresh token, resend
 *   - entry already verified                  -> send a benign "already on the
 *                                                list" note (or nothing if no
 *                                                mailer is wired)
 *
 * Returns whether the existing entry is pending verification so the caller can
 * mirror the brand-new response's `pendingVerification` flag exactly.
 */
export async function resendForExistingEmail(
  prisma: PrismaClient,
  rawEmail: string,
  opts: { mailer?: Mailer; sendEmail?: boolean } = {}
): Promise<{ pendingVerification: boolean }> {
  const email = normalizeEmail(rawEmail);
  const entry = await prisma.waitlist.findUnique({ where: { email } });
  if (!entry) {
    // Shouldn't happen (caller only invokes this on a known duplicate), but fail
    // safe by mirroring the configured default.
    return { pendingVerification: isEmailVerificationEnabled() };
  }

  const pending = !entry.verified;

  if (pending) {
    // Ensure there is a live token to send; refresh it if missing/expired.
    let token = entry.verifyToken;
    if (!tokenIsLive(entry)) {
      const minted = newVerificationToken();
      token = minted.token;
      try {
        await prisma.waitlist.update({
          where: { id: entry.id },
          data: { verifyToken: minted.token, verifyTokenExpiresAt: minted.expiresAt },
        });
      } catch {
        /* a concurrent verify/update can lose this race; the email below is best-effort */
      }
    }
    if (opts.sendEmail && opts.mailer && token) {
      try {
        await opts.mailer.send(buildVerificationEmail({ email: entry.email, verifyToken: token }));
      } catch {
        /* swallow: email is best-effort */
      }
    }
    return { pendingVerification: true };
  }

  // Already verified: send a gentle, data-free reassurance email.
  if (opts.sendEmail && opts.mailer) {
    try {
      await opts.mailer.send(buildAlreadyOnListEmail({ email: entry.email }));
    } catch {
      /* swallow */
    }
  }
  return { pendingVerification: false };
}

/**
 * Count of VERIFIED people directly referred by a given entry id.
 *
 * REFERRAL-CREDIT RULE (documented + tested): a referral only counts once the
 * referred signup has confirmed their email. Unverified (pending) referrals do
 * NOT move the referrer up the list or onto the leaderboard. This prevents
 * gaming the loop with throwaway/unconfirmable addresses. When email
 * verification is disabled (REQUIRE_EMAIL_VERIFICATION=false), every signup is
 * created verified, so all referrals count immediately.
 */
export async function referralCount(prisma: PrismaClient, id: string): Promise<number> {
  return prisma.waitlist.count({ where: { referredById: id, verified: true } });
}

/** Fetch a single entry by referral code, with effective position. */
export async function getEntryByCode(
  prisma: PrismaClient,
  referralCode: string
): Promise<SignupResult & { referralCount: number }> {
  const entry = await prisma.waitlist.findUnique({
    where: { referralCode: referralCode.trim() },
  });
  if (!entry) {
    throw new WaitlistError("NOT_FOUND", "No entry found for that referral code.");
  }
  const count = await referralCount(prisma, entry.id);
  return {
    id: entry.id,
    email: entry.email,
    referralCode: entry.referralCode,
    basePosition: entry.position,
    position: effectivePosition(entry.position, count),
    referredById: entry.referredById,
    verified: entry.verified,
    pendingVerification: !entry.verified,
    createdAt: entry.createdAt,
    referralCount: count,
  };
}

export interface LeaderboardRow {
  id: string;
  email: string;
  referralCode: string;
  referralCount: number;
  basePosition: number;
  position: number;
}

/**
 * Top referrers, ranked by referral count (desc), ties broken by earliest
 * join (createdAt asc). Single grouped query for the counts.
 */
export async function leaderboard(
  prisma: PrismaClient,
  limit = 10
): Promise<LeaderboardRow[]> {
  // One grouped query to get VERIFIED referral counts per referrer.
  const grouped = await prisma.waitlist.groupBy({
    by: ["referredById"],
    where: { referredById: { not: null }, verified: true },
    _count: { referredById: true },
  });

  const counts = new Map<string, number>();
  for (const g of grouped) {
    if (g.referredById) counts.set(g.referredById, g._count.referredById);
  }

  const ids = [...counts.keys()];
  if (ids.length === 0) return [];

  const referrers = await prisma.waitlist.findMany({
    where: { id: { in: ids } },
  });

  const rows: LeaderboardRow[] = referrers.map((r) => {
    const c = counts.get(r.id) ?? 0;
    return {
      id: r.id,
      email: r.email,
      referralCode: r.referralCode,
      referralCount: c,
      basePosition: r.position,
      position: effectivePosition(r.position, c),
    };
  });

  rows.sort((a, b) => {
    if (b.referralCount !== a.referralCount) return b.referralCount - a.referralCount;
    // tie-break: lower base position (joined earlier) ranks first
    return a.basePosition - b.basePosition;
  });

  return rows.slice(0, limit);
}

/**
 * Send the milestone email if the referrer's referral count is exactly at a
 * multiple of the configured threshold (so it fires at 3, 6, 9, ... by default,
 * not on every referral after the first milestone).
 */
async function maybeSendMilestone(
  prisma: PrismaClient,
  referrerId: string,
  mailer: Mailer
): Promise<void> {
  const threshold = getMilestoneThreshold();
  const count = await referralCount(prisma, referrerId);
  if (count > 0 && count % threshold === 0) {
    const referrer = await prisma.waitlist.findUnique({ where: { id: referrerId } });
    if (!referrer) return;
    await mailer.send(
      buildMilestoneEmail({
        email: referrer.email,
        referralCount: count,
        position: effectivePosition(referrer.position, count),
      })
    );
  }
}

/** Total number of signups. */
export async function totalSignups(prisma: PrismaClient): Promise<number> {
  return prisma.waitlist.count();
}

/** Admin listing: all signups, newest first, with referral counts. */
export async function listSignups(
  prisma: PrismaClient,
  opts: { take?: number; skip?: number } = {}
): Promise<{ total: number; rows: (LeaderboardRow & { createdAt: Date; verified: boolean })[] }> {
  const total = await prisma.waitlist.count();
  const entries = await prisma.waitlist.findMany({
    orderBy: { createdAt: "desc" },
    take: opts.take ?? 100,
    skip: opts.skip ?? 0,
  });

  const grouped = await prisma.waitlist.groupBy({
    by: ["referredById"],
    where: { referredById: { not: null }, verified: true },
    _count: { referredById: true },
  });
  const counts = new Map<string, number>();
  for (const g of grouped) if (g.referredById) counts.set(g.referredById, g._count.referredById);

  const rows = entries.map((e) => {
    const c = counts.get(e.id) ?? 0;
    return {
      id: e.id,
      email: e.email,
      referralCode: e.referralCode,
      referralCount: c,
      basePosition: e.position,
      position: effectivePosition(e.position, c),
      createdAt: e.createdAt,
      verified: e.verified,
    };
  });

  return { total, rows };
}

/** One exported waitlist record, shaped for the admin CSV. */
export interface ExportRow {
  email: string;
  referralCode: string;
  verified: boolean;
  referralCount: number;
  basePosition: number;
  position: number;
  createdAt: Date;
}

/**
 * Stream every signup for the admin CSV export, in batches, so the route never
 * loads the whole table into memory at once. The (bounded) per-referrer verified
 * counts are fetched once up front via a single grouped query; entries are then
 * paged with keyset (cursor) pagination on the primary key.
 */
export async function* streamSignupsForCsv(
  prisma: PrismaClient,
  batchSize = 500
): AsyncGenerator<ExportRow> {
  const take = Math.max(1, Math.floor(batchSize));

  // Verified-referral counts per referrer. This is aggregated (one row per
  // referrer, a subset of the table), so it stays small even for large lists.
  const grouped = await prisma.waitlist.groupBy({
    by: ["referredById"],
    where: { referredById: { not: null }, verified: true },
    _count: { referredById: true },
  });
  const counts = new Map<string, number>();
  for (const g of grouped) if (g.referredById) counts.set(g.referredById, g._count.referredById);

  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.waitlist.findMany({
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
    });
    if (batch.length === 0) break;

    for (const e of batch) {
      const c = counts.get(e.id) ?? 0;
      yield {
        email: e.email,
        referralCode: e.referralCode,
        verified: e.verified,
        referralCount: c,
        basePosition: e.position,
        position: effectivePosition(e.position, c),
        createdAt: e.createdAt,
      };
    }

    if (batch.length < take) break;
    cursor = batch[batch.length - 1].id;
  }
}
