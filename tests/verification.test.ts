// Double-opt-in verification flow, with email verification ENABLED.
process.env.REQUIRE_EMAIL_VERIFICATION = "true";

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, resetDb, MockMailer } from "./helpers";
import {
  signup,
  verifyEmail,
  referralCount,
  leaderboard,
  getEntryByCode,
  WaitlistError,
} from "../lib/waitlist";

beforeEach(async () => {
  process.env.REQUIRE_EMAIL_VERIFICATION = "true";
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// Pull the verifyToken straight from the DB (it is not returned by signup()).
async function tokenFor(email: string): Promise<string> {
  const row = await prisma.waitlist.findUnique({ where: { email } });
  if (!row?.verifyToken) throw new Error(`no token for ${email}`);
  return row.verifyToken;
}

describe("signup with verification enabled", () => {
  it("creates a PENDING (unverified) entry and emails a verify link", async () => {
    const mailer = new MockMailer();
    const r = await signup(prisma, { email: "p@example.com" }, { mailer, sendEmail: true });

    expect(r.verified).toBe(false);
    expect(r.pendingVerification).toBe(true);

    const row = await prisma.waitlist.findUnique({ where: { email: "p@example.com" } });
    expect(row?.verified).toBe(false);
    expect(row?.verifyToken).toBeTruthy();

    // The first (and only) email is the verification email, not the welcome.
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toMatch(/confirm/i);
    expect(mailer.sent[0].to).toBe("p@example.com");
    // It contains a verify link with the token.
    expect(mailer.sent[0].text).toContain("/api/verify?token=");
  });
});

describe("verifyEmail", () => {
  it("confirms the entry, clears the token, and sends the welcome email", async () => {
    const mailer = new MockMailer();
    await signup(prisma, { email: "v@example.com" }, { mailer, sendEmail: true });
    const token = await tokenFor("v@example.com");
    mailer.reset();

    const res = await verifyEmail(prisma, token, { mailer, sendEmail: true });
    expect(res.alreadyVerified).toBe(false);

    const row = await prisma.waitlist.findUnique({ where: { email: "v@example.com" } });
    expect(row?.verified).toBe(true);
    expect(row?.verifiedAt).toBeTruthy();
    expect(row?.verifyToken).toBeNull();

    // Welcome confirmation now fires.
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toMatch(/waitlist/i);
  });

  it("is idempotent when the same token is re-used after verifying", async () => {
    const mailer = new MockMailer();
    await signup(prisma, { email: "idem@example.com" }, { mailer, sendEmail: true });
    const token = await tokenFor("idem@example.com");
    await verifyEmail(prisma, token, { mailer, sendEmail: true });
    // Token is cleared on first verify -> second call sees an invalid token.
    await expect(verifyEmail(prisma, token, { mailer, sendEmail: true })).rejects.toMatchObject({
      code: "INVALID_TOKEN",
    });
  });

  it("rejects an unknown token", async () => {
    await expect(verifyEmail(prisma, "NOPE")).rejects.toBeInstanceOf(WaitlistError);
    await expect(verifyEmail(prisma, "NOPE")).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("rejects an empty token", async () => {
    await expect(verifyEmail(prisma, "")).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });
});

describe("referral credit only counts VERIFIED signups", () => {
  it("does not credit the referrer until the referred signup is verified", async () => {
    const mailer = new MockMailer();
    const ref = await signup(prisma, { email: "ref@example.com" }, { mailer, sendEmail: true });
    // Referrer must verify too, to appear with a real entry (doesn't affect their own credit).
    await verifyEmail(prisma, await tokenFor("ref@example.com"), { mailer, sendEmail: true });

    // Child signs up with the referrer's code but does NOT verify yet.
    await signup(
      prisma,
      { email: "child@example.com", referredByCode: ref.referralCode },
      { mailer, sendEmail: true }
    );

    expect(await referralCount(prisma, ref.id)).toBe(0);
    // Not on the leaderboard yet (0 verified referrals).
    expect(await leaderboard(prisma)).toEqual([]);

    // Child verifies -> credit now counts.
    await verifyEmail(prisma, await tokenFor("child@example.com"), { mailer, sendEmail: true });
    expect(await referralCount(prisma, ref.id)).toBe(1);

    const board = await leaderboard(prisma);
    expect(board).toHaveLength(1);
    expect(board[0].email).toBe("ref@example.com");
    expect(board[0].referralCount).toBe(1);
  });

  it("position boost only applies for verified referrals", async () => {
    const mailer = new MockMailer();
    const a = await signup(prisma, { email: "a@example.com" }, { mailer, sendEmail: true });
    await verifyEmail(prisma, await tokenFor("a@example.com"), { mailer, sendEmail: true });
    // a is base position 1.

    // Two referrals, neither verified yet -> no boost.
    await signup(prisma, { email: "c1@example.com", referredByCode: a.referralCode }, { mailer, sendEmail: true });
    await signup(prisma, { email: "c2@example.com", referredByCode: a.referralCode }, { mailer, sendEmail: true });
    let entry = await getEntryByCode(prisma, a.referralCode);
    expect(entry.referralCount).toBe(0);
    expect(entry.position).toBe(entry.basePosition);

    // Verify one referral -> count 1.
    await verifyEmail(prisma, await tokenFor("c1@example.com"), { mailer, sendEmail: true });
    entry = await getEntryByCode(prisma, a.referralCode);
    expect(entry.referralCount).toBe(1);
  });

  it("fires the milestone email only after the threshold in VERIFIED referrals", async () => {
    const mailer = new MockMailer();
    const ref = await signup(prisma, { email: "ml@example.com" }, { mailer, sendEmail: true });
    await verifyEmail(prisma, await tokenFor("ml@example.com"), { mailer, sendEmail: true });
    mailer.reset();

    // Three referrals sign up (default threshold 3) but none verified -> no milestone.
    for (const e of ["x1@x.com", "x2@x.com", "x3@x.com"]) {
      await signup(prisma, { email: e, referredByCode: ref.referralCode }, { mailer, sendEmail: true });
    }
    expect(mailer.sent.filter((m) => m.subject.includes("referred"))).toHaveLength(0);

    // Verify the first two -> still below threshold.
    await verifyEmail(prisma, await tokenFor("x1@x.com"), { mailer, sendEmail: true });
    await verifyEmail(prisma, await tokenFor("x2@x.com"), { mailer, sendEmail: true });
    expect(mailer.sent.filter((m) => m.subject.includes("referred"))).toHaveLength(0);

    // Verify the third -> milestone fires to the referrer.
    await verifyEmail(prisma, await tokenFor("x3@x.com"), { mailer, sendEmail: true });
    const milestones = mailer.sent.filter((m) => m.subject.includes("referred"));
    expect(milestones).toHaveLength(1);
    expect(milestones[0].to).toBe("ml@example.com");
  });
});
