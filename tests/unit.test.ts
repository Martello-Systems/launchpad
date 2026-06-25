import { describe, it, expect } from "vitest";
import { generateReferralCode } from "../lib/referral-code";
import { effectivePosition, normalizeEmail } from "../lib/waitlist";
import { buildConfirmationEmail, buildMilestoneEmail } from "../lib/mailer";
import { toCsv, csvHeaderLine, csvRowLine } from "../lib/csv";
import { maskEmail } from "../lib/format";
import { enforceMinDuration } from "../lib/timing";

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

describe("toCsv", () => {
  const cols = [
    { key: "email" as const, header: "email" },
    { key: "count" as const, header: "count" },
  ];

  it("writes a header row and CRLF-terminated rows", () => {
    const out = toCsv(cols, [{ email: "a@b.com", count: 2 }]);
    expect(out).toBe("email,count\r\na@b.com,2\r\n");
  });

  it("quotes and escapes values containing commas, quotes, or newlines", () => {
    const out = toCsv([{ key: "v" as const, header: "v" }], [
      { v: 'a,b' },
      { v: 'he said "hi"' },
      { v: "line1\nline2" },
    ]);
    expect(out).toContain('"a,b"');
    expect(out).toContain('"he said ""hi"""');
    expect(out).toContain('"line1\nline2"');
  });

  it("neutralizes spreadsheet formula injection", () => {
    const out = toCsv([{ key: "v" as const, header: "v" }], [{ v: "=SUM(A1:A2)" }]);
    // Leading "=" gets a defanging apostrophe prefix.
    expect(out).toContain("'=SUM");
  });

  it("serializes dates as ISO and blanks null/undefined", () => {
    const out = toCsv(
      [
        { key: "d" as const, header: "d" },
        { key: "n" as const, header: "n" },
      ],
      [{ d: new Date("2026-01-02T03:04:05.000Z"), n: null }]
    );
    expect(out).toContain("2026-01-02T03:04:05.000Z");
    expect(out.trim().endsWith(",")).toBe(true); // null -> empty trailing cell
  });

  it("streaming line helpers reproduce toCsv byte-for-byte", () => {
    const cols = [
      { key: "email" as const, header: "email" },
      { key: "count" as const, header: "count" },
    ];
    const rows = [
      { email: "a@b.com", count: 2 },
      { email: "c,d@e.com", count: 5 }, // contains a comma -> must be quoted
    ];
    const streamed = csvHeaderLine(cols) + rows.map((r) => csvRowLine(cols, r)).join("");
    expect(streamed).toBe(toCsv(cols, rows));
  });
});

describe("maskEmail (shared helper)", () => {
  it("keeps the first char and the domain, stars the rest", () => {
    expect(maskEmail("alice@example.com")).toBe("a****@example.com");
  });
  it("uses at least two stars for short local parts", () => {
    expect(maskEmail("a@b.com")).toBe("a**@b.com");
    expect(maskEmail("ab@b.com")).toBe("a**@b.com");
  });
  it("degrades safely on a malformed address", () => {
    expect(maskEmail("not-an-email")).toBe("***");
  });
});

describe("enforceMinDuration (timing floor)", () => {
  it("waits until the floor when work finished early", async () => {
    const start = Date.now();
    const slept = await enforceMinDuration(start, 60);
    const elapsed = Date.now() - start;
    expect(slept).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(55); // ~60ms, allow scheduler slack
  });

  it("is a no-op when the floor already elapsed", async () => {
    const start = Date.now() - 1000; // pretend work took 1s already
    expect(await enforceMinDuration(start, 50)).toBe(0);
  });

  it("is a no-op for a zero/negative floor", async () => {
    expect(await enforceMinDuration(Date.now(), 0)).toBe(0);
    expect(await enforceMinDuration(Date.now(), -5)).toBe(0);
  });
});
