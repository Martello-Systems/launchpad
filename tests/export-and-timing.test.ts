// Two P2 hardening behaviors that need the real DB:
//   1. CSV export streams the table in batches (no whole-table load), and the
//      streamed body still contains every row.
//   2. The signup endpoint pads new vs. existing-email responses to the same
//      time floor (timing side-channel), on top of the identical body shape that
//      tests/anti-enumeration.test.ts already covers.
process.env.REQUIRE_EMAIL_VERIFICATION = "false";

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma, resetDb, MockMailer } from "./helpers";
import { signup, streamSignupsForCsv } from "../lib/waitlist";
import { GET as exportGet } from "../app/api/admin/export/route";
import { POST as signupPost } from "../app/api/signup/route";
import { __resetSignupLimiterForTests } from "../lib/rate-limit";

const ADMIN_TOKEN = "test-admin-token-aaaaaaaaaaaa";

beforeEach(async () => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.RATE_LIMIT_MAX = "1000";
  __resetSignupLimiterForTests();
  await resetDb();
});

afterAll(async () => {
  delete process.env.ADMIN_TOKEN;
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.CSV_EXPORT_BATCH_SIZE;
  delete process.env.SIGNUP_MIN_RESPONSE_MS;
  await prisma.$disconnect();
});

async function seed(n: number): Promise<void> {
  const mailer = new MockMailer();
  for (let i = 0; i < n; i++) {
    await signup(prisma, { email: `u${i}@example.com` }, { mailer, sendEmail: false });
  }
}

describe("admin CSV export streams in batches", () => {
  it("streamSignupsForCsv yields every row across multiple small batches", async () => {
    await seed(7);
    const rows = [];
    for await (const r of streamSignupsForCsv(prisma, 2)) rows.push(r);
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((r) => r.email)).size).toBe(7);
  });

  it("the export route returns a streamed CSV with the header + every row", async () => {
    process.env.CSV_EXPORT_BATCH_SIZE = "2"; // force several pages
    await seed(5);

    const req = new NextRequest("http://localhost/api/admin/export", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const res = await exportGet(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);

    const text = await res.text();
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toBe(
      "email,referral_code,verified,verified_referrals,base_position,effective_position,created_at"
    );
    expect(lines).toHaveLength(1 + 5); // header + 5 data rows
    for (let i = 0; i < 5; i++) expect(text).toContain(`u${i}@example.com`);
  });

  it("rejects an unauthenticated export", async () => {
    const res = await exportGet(new NextRequest("http://localhost/api/admin/export"));
    expect(res.status).toBe(401);
  });
});

describe("signup response timing is enumeration-resistant", () => {
  function post(email: string): Promise<{ ms: number; status: number }> {
    const req = new NextRequest("http://localhost/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const t0 = Date.now();
    return signupPost(req).then((res) => ({ ms: Date.now() - t0, status: res.status }));
  }

  it("pads both a brand-new and a duplicate signup up to the same time floor", async () => {
    const FLOOR = 140;
    process.env.SIGNUP_MIN_RESPONSE_MS = String(FLOOR);

    const fresh = await post("timing-new@example.com");
    const duplicate = await post("timing-new@example.com"); // now exists

    expect(fresh.status).toBe(200);
    expect(duplicate.status).toBe(200);
    // Both responses honor the floor, so latency doesn't disclose existence.
    expect(fresh.ms).toBeGreaterThanOrEqual(FLOOR - 15);
    expect(duplicate.ms).toBeGreaterThanOrEqual(FLOOR - 15);
  });
});
