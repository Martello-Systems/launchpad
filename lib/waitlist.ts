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
  isEmailVerificationEnabled,
} from "./config";
import {
  buildConfirmationEmail,
  buildMilestoneEmail,
  buildVerificationEmail,
  type Mailer,
} from "./mailer";

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
    // failing the signup — the person still wants to join.
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
  const verifyToken = verificationEnabled ? generateReferralCode(24) : null;

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
      /* swallow — email is not critical to the signup transaction */
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
 * confirmation email and credits the referrer's milestone — because referral
 * credit only counts verified signups.
 *
 * Throws WaitlistError("INVALID_TOKEN") for an unknown/used token. Verifying an
 * already-verified entry (e.g. a double-clicked link where the token still
 * matches) is idempotent and does not re-send emails.
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
    // Token still present but already verified — treat as idempotent success.
    return { id: entry.id, email: entry.email, alreadyVerified: true };
  }

  const updated = await prisma.waitlist.update({
    where: { id: entry.id },
    data: { verified: true, verifiedAt: new Date(), verifyToken: null },
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
      /* swallow — email is not critical to verification */
    }
  }

  return { id: updated.id, email: updated.email, alreadyVerified: false };
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
 * multiple of the configured threshold (so it fires at 3, 6, 9, ... by default
 * — not on every referral after the first milestone).
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
