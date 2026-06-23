import { describe, it, expect } from "vitest";
import { generateReferralCode } from "../lib/referral-code";
import { effectivePosition, normalizeEmail } from "../lib/waitlist";
import { buildConfirmationEmail, buildMilestoneEmail } from "../lib/mailer";

describe("referral codes", () => {
  it("generates codes of the requested length from the safe alphabet", () => {
    const code = generateReferralCode(8);
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
  });

  it("is effectively unique across many draws", () => {
    const set = new Set<string>();
    for (let i = 0; i < 5000; i++) set.add(generateReferralCode(8));
    // Collisions in 5000 draws over 30^8 space should be vanishingly unlikely.
    expect(set.size).toBe(5000);
  });
});

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
});

describe("position rule (effectivePosition)", () => {
  it("returns base position with no referrals", () => {
    expect(effectivePosition(10, 0)).toBe(10);
  });
  it("moves up one slot per referral (default boost = 1)", () => {
    expect(effectivePosition(10, 3)).toBe(7);
  });
  it("never goes below 1", () => {
    expect(effectivePosition(2, 50)).toBe(1);
  });
});

describe("email builders", () => {
  it("confirmation email includes position and code", () => {
    const m = buildConfirmationEmail({ email: "a@b.com", referralCode: "ABCD2345", position: 5 });
    expect(m.to).toBe("a@b.com");
    expect(m.text).toContain("#5");
    expect(m.text).toContain("ABCD2345");
    expect(m.html).toContain("ABCD2345");
  });
  it("milestone email includes the count", () => {
    const m = buildMilestoneEmail({ email: "a@b.com", referralCount: 3, position: 4 });
    expect(m.subject).toContain("3");
    expect(m.text).toContain("3 referrals");
  });
});
