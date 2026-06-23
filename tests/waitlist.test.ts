import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, resetDb, MockMailer } from "./helpers";
import {
  signup,
  leaderboard,
  listSignups,
  getEntryByCode,
  referralCount,
  totalSignups,
  WaitlistError,
} from "../lib/waitlist";

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("signup", () => {
  it("creates an entry with a referral code and position 1 for the first signup", async () => {
    const r = await signup(prisma, { email: "first@example.com" });
    expect(r.email).toBe("first@example.com");
    expect(r.referralCode).toMatch(/^[A-Z0-9]{8,}$/);
    expect(r.basePosition).toBe(1);
    expect(r.position).toBe(1);
    expect(r.referredById).toBeNull();
  });

  it("assigns sequential positions as people join", async () => {
    const a = await signup(prisma, { email: "a@example.com" });
    const b = await signup(prisma, { email: "b@example.com" });
    const c = await signup(prisma, { email: "c@example.com" });
    expect(a.basePosition).toBe(1);
    expect(b.basePosition).toBe(2);
    expect(c.basePosition).toBe(3);
  });

  it("normalizes email (case/whitespace)", async () => {
    const r = await signup(prisma, { email: "  Mixed@CASE.com " });
    expect(r.email).toBe("mixed@case.com");
  });

  it("rejects duplicate emails with DUPLICATE_EMAIL", async () => {
    await signup(prisma, { email: "dup@example.com" });
    await expect(signup(prisma, { email: "DUP@example.com" })).rejects.toMatchObject({
      code: "DUPLICATE_EMAIL",
    });
  });

  it("rejects invalid emails with INVALID_EMAIL", async () => {
    await expect(signup(prisma, { email: "not-an-email" })).rejects.toBeInstanceOf(WaitlistError);
    await expect(signup(prisma, { email: "not-an-email" })).rejects.toMatchObject({
      code: "INVALID_EMAIL",
    });
  });

  it("generates unique referral codes across signups", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const r = await signup(prisma, { email: `u${i}@example.com` });
      codes.add(r.referralCode);
    }
    expect(codes.size).toBe(25);
  });
});

describe("referral attribution", () => {
  it("credits the referrer when someone signs up with their code", async () => {
    const ref = await signup(prisma, { email: "referrer@example.com" });
    const child = await signup(prisma, {
      email: "child@example.com",
      referredByCode: ref.referralCode,
    });
    expect(child.referredById).toBe(ref.id);
    expect(await referralCount(prisma, ref.id)).toBe(1);
  });

  it("ignores unknown referral codes (still signs up, no attribution)", async () => {
    const r = await signup(prisma, {
      email: "orphan@example.com",
      referredByCode: "NONEXIST",
    });
    expect(r.referredById).toBeNull();
    expect(await totalSignups(prisma)).toBe(1);
  });

  it("counts multiple referrals for the same referrer", async () => {
    const ref = await signup(prisma, { email: "boss@example.com" });
    for (let i = 0; i < 4; i++) {
      await signup(prisma, { email: `rec${i}@example.com`, referredByCode: ref.referralCode });
    }
    expect(await referralCount(prisma, ref.id)).toBe(4);
  });
});

describe("position boost from referrals", () => {
  it("improves the referrer's effective position by 1 per referral", async () => {
    // Three people join: positions 1,2,3.
    const p1 = await signup(prisma, { email: "p1@example.com" }); // base 1
    const p2 = await signup(prisma, { email: "p2@example.com" }); // base 2
    await signup(prisma, { email: "p3@example.com" }); // base 3

    // p2 (base position 2) refers two people -> effective position max(1, 2-2)=1
    await signup(prisma, { email: "r1@example.com", referredByCode: p2.referralCode });
    await signup(prisma, { email: "r2@example.com", referredByCode: p2.referralCode });

    const entry = await getEntryByCode(prisma, p2.referralCode);
    expect(entry.referralCount).toBe(2);
    expect(entry.basePosition).toBe(2);
    expect(entry.position).toBe(1);

    // p1 unchanged
    const e1 = await getEntryByCode(prisma, p1.referralCode);
    expect(e1.position).toBe(1);
  });
});

describe("leaderboard", () => {
  it("ranks referrers by referral count descending", async () => {
    const top = await signup(prisma, { email: "top@example.com" });
    const mid = await signup(prisma, { email: "mid@example.com" });
    const low = await signup(prisma, { email: "low@example.com" });

    // top: 3 referrals, mid: 2, low: 1
    for (let i = 0; i < 3; i++)
      await signup(prisma, { email: `t${i}@x.com`, referredByCode: top.referralCode });
    for (let i = 0; i < 2; i++)
      await signup(prisma, { email: `m${i}@x.com`, referredByCode: mid.referralCode });
    await signup(prisma, { email: "l0@x.com", referredByCode: low.referralCode });

    const board = await leaderboard(prisma, 10);
    expect(board.map((r) => r.email)).toEqual([
      "top@example.com",
      "mid@example.com",
      "low@example.com",
    ]);
    expect(board[0].referralCount).toBe(3);
    expect(board[2].referralCount).toBe(1);
  });

  it("breaks ties by earliest join (lower base position first)", async () => {
    const early = await signup(prisma, { email: "early@example.com" }); // base 1
    const late = await signup(prisma, { email: "late@example.com" }); // base 2

    // both get exactly 1 referral
    await signup(prisma, { email: "e1@x.com", referredByCode: early.referralCode });
    await signup(prisma, { email: "l1@x.com", referredByCode: late.referralCode });

    const board = await leaderboard(prisma, 10);
    expect(board[0].email).toBe("early@example.com");
    expect(board[1].email).toBe("late@example.com");
  });

  it("returns empty when there are no referrals", async () => {
    await signup(prisma, { email: "solo@example.com" });
    expect(await leaderboard(prisma)).toEqual([]);
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 5; i++) {
      const ref = await signup(prisma, { email: `ref${i}@x.com` });
      await signup(prisma, { email: `c${i}@x.com`, referredByCode: ref.referralCode });
    }
    const board = await leaderboard(prisma, 2);
    expect(board).toHaveLength(2);
  });
});

describe("email behavior (mock mailer)", () => {
  it("sends a confirmation email on signup when enabled", async () => {
    const mailer = new MockMailer();
    await signup(prisma, { email: "conf@example.com" }, { mailer, sendEmail: true });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe("conf@example.com");
    expect(mailer.sent[0].subject).toMatch(/waitlist/i);
  });

  it("does not send when sendEmail is false", async () => {
    const mailer = new MockMailer();
    await signup(prisma, { email: "nomail@example.com" }, { mailer, sendEmail: false });
    expect(mailer.sent).toHaveLength(0);
  });

  it("fires a milestone email when the referrer hits the threshold", async () => {
    const mailer = new MockMailer();
    const ref = await signup(prisma, { email: "ml@example.com" }, { mailer, sendEmail: true });
    mailer.reset();

    // Default threshold is 3. Two referrals: no milestone yet.
    await signup(prisma, { email: "a@x.com", referredByCode: ref.referralCode }, { mailer, sendEmail: true });
    await signup(prisma, { email: "b@x.com", referredByCode: ref.referralCode }, { mailer, sendEmail: true });
    let milestones = mailer.sent.filter((m) => m.subject.includes("referred"));
    expect(milestones).toHaveLength(0);

    // Third referral -> milestone email to the referrer.
    await signup(prisma, { email: "c@x.com", referredByCode: ref.referralCode }, { mailer, sendEmail: true });
    milestones = mailer.sent.filter((m) => m.subject.includes("referred"));
    expect(milestones).toHaveLength(1);
    expect(milestones[0].to).toBe("ml@example.com");
  });
});

describe("listSignups (admin)", () => {
  it("returns all signups newest-first with referral counts", async () => {
    const ref = await signup(prisma, { email: "adm-ref@example.com" });
    await signup(prisma, { email: "adm-c1@example.com", referredByCode: ref.referralCode });
    await signup(prisma, { email: "adm-c2@example.com", referredByCode: ref.referralCode });

    const { total, rows } = await listSignups(prisma);
    expect(total).toBe(3);
    // newest first
    expect(rows[0].email).toBe("adm-c2@example.com");
    const refRow = rows.find((r) => r.email === "adm-ref@example.com")!;
    expect(refRow.referralCount).toBe(2);
  });
});
