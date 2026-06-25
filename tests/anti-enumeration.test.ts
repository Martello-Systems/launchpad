// Email-enumeration hardening: the signup endpoint must respond identically
// whether or not an email is already on the list, and the resend helper must
// re-send a benign email without disclosing existence. Verification is ON.
process.env.REQUIRE_EMAIL_VERIFICATION = "true";

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma, resetDb, MockMailer } from "./helpers";
import { resendForExistingEmail, signup, verifyEmail } from "../lib/waitlist";
import { POST } from "../app/api/signup/route";
import { __resetSignupLimiterForTests } from "../lib/rate-limit";

beforeEach(async () => {
  process.env.REQUIRE_EMAIL_VERIFICATION = "true";
  process.env.RATE_LIMIT_MAX = "1000"; // don't let the limiter interfere
  __resetSignupLimiterForTests();
  await resetDb();
});

afterAll(async () => {
  delete process.env.RATE_LIMIT_MAX;
  await prisma.$disconnect();
});

function signupReq(email: string): NextRequest {
  return new NextRequest("http://localhost/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

async function post(email: string) {
  const res = await POST(signupReq(email));
  const body = await res.json();
  return { status: res.status, body };
}

describe("signup endpoint does not leak which emails exist", () => {
  it("returns an identical body+status for a new email and a duplicate", async () => {
    const fresh = await post("new-person@example.com");

    // Same email again (now a duplicate).
    const duplicate = await post("new-person@example.com");

    // A different brand-new email, for good measure.
    const otherFresh = await post("another-new@example.com");

    expect(duplicate.status).toBe(fresh.status);
    expect(duplicate.body).toEqual(fresh.body);
    expect(otherFresh.body).toEqual(fresh.body);

    // And the body carries no per-account data (no code, position, or link).
    expect(fresh.status).toBe(200);
    expect(fresh.body.pendingVerification).toBe(true);
    expect(fresh.body).not.toHaveProperty("referralCode");
    expect(fresh.body).not.toHaveProperty("position");
    expect(fresh.body).not.toHaveProperty("referralLink");
  });

  it("returns the same body whether the duplicate is pending or already verified", async () => {
    // Create + verify one account.
    const mailer = new MockMailer();
    await signup(prisma, { email: "verified@example.com" }, { mailer, sendEmail: true });
    const row = await prisma.waitlist.findUnique({ where: { email: "verified@example.com" } });
    await verifyEmail(prisma, row!.verifyToken!, { mailer, sendEmail: true });

    const onVerifiedDup = await post("verified@example.com");
    const onFresh = await post("brand-new@example.com");
    expect(onVerifiedDup.body).toEqual(onFresh.body);
    expect(onVerifiedDup.status).toBe(onFresh.status);
  });
});

describe("resendForExistingEmail", () => {
  it("re-sends the verification link for a still-pending entry", async () => {
    const setup = new MockMailer();
    await signup(prisma, { email: "pending@example.com" }, { mailer: setup, sendEmail: true });

    const mailer = new MockMailer();
    const out = await resendForExistingEmail(prisma, "PENDING@example.com", {
      mailer,
      sendEmail: true,
    });

    expect(out.pendingVerification).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toMatch(/confirm/i);
    expect(mailer.sent[0].text).toContain("/api/verify?token=");
  });

  it("sends a benign 'already on the list' note for a verified entry", async () => {
    const setup = new MockMailer();
    await signup(prisma, { email: "done@example.com" }, { mailer: setup, sendEmail: true });
    const row = await prisma.waitlist.findUnique({ where: { email: "done@example.com" } });
    await verifyEmail(prisma, row!.verifyToken!, { mailer: setup, sendEmail: true });

    const mailer = new MockMailer();
    const out = await resendForExistingEmail(prisma, "done@example.com", { mailer, sendEmail: true });

    expect(out.pendingVerification).toBe(false);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toMatch(/already/i);
    // No token / referral data leaked.
    expect(mailer.sent[0].text).not.toContain("/api/verify?token=");
  });

  it("mints a fresh token when the pending entry's token has expired", async () => {
    const setup = new MockMailer();
    await signup(prisma, { email: "stale@example.com" }, { mailer: setup, sendEmail: true });
    const before = await prisma.waitlist.findUnique({ where: { email: "stale@example.com" } });
    // Force the token into the past.
    await prisma.waitlist.update({
      where: { id: before!.id },
      data: { verifyTokenExpiresAt: new Date(Date.now() - 1000) },
    });

    const mailer = new MockMailer();
    const out = await resendForExistingEmail(prisma, "stale@example.com", { mailer, sendEmail: true });
    expect(out.pendingVerification).toBe(true);

    const after = await prisma.waitlist.findUnique({ where: { email: "stale@example.com" } });
    expect(after!.verifyToken).not.toBe(before!.verifyToken);
    expect(after!.verifyTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    // The freshly minted token is the one emailed.
    expect(mailer.sent[0].text).toContain(after!.verifyToken!);
  });
});
