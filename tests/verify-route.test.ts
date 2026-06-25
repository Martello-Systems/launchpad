// Route-level behavior of /api/verify: a GET (browser prefetch / corporate
// link-scanner) must NOT consume the single-use token; only a POST consumes it,
// and a repeat POST is idempotent ("already confirmed"), never an error.
process.env.REQUIRE_EMAIL_VERIFICATION = "true";

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma, resetDb, MockMailer } from "./helpers";
import { signup } from "../lib/waitlist";
import { GET, POST } from "../app/api/verify/route";

beforeEach(async () => {
  process.env.REQUIRE_EMAIL_VERIFICATION = "true";
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function tokenFor(email: string): Promise<string> {
  const row = await prisma.waitlist.findUnique({ where: { email } });
  if (!row?.verifyToken) throw new Error(`no token for ${email}`);
  return row.verifyToken;
}

function getReq(token: string, accept?: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/verify?token=${encodeURIComponent(token)}`,
    { method: "GET", headers: accept ? { accept } : undefined }
  );
}

function postForm(token: string): NextRequest {
  return new NextRequest("http://localhost/api/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
}

function postJson(token: string): NextRequest {
  return new NextRequest("http://localhost/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ token }),
  });
}

describe("GET /api/verify is non-destructive (link-scanner safe)", () => {
  it("a bare browser GET renders a confirm page and does NOT consume the token", async () => {
    const mailer = new MockMailer();
    await signup(prisma, { email: "g@example.com" }, { mailer, sendEmail: true });
    const token = await tokenFor("g@example.com");

    const res = await GET(getReq(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toMatch(/Confirm my spot/i);
    // The form POSTs back so the human actually consumes the token.
    expect(html).toContain('method="POST"');

    // CRITICAL: the entry is still pending and the token is untouched.
    const row = await prisma.waitlist.findUnique({ where: { email: "g@example.com" } });
    expect(row?.verified).toBe(false);
    expect(row?.verifyToken).toBe(token);
  });

  it("a JSON GET (scanner) reports confirmRequired and does NOT consume the token", async () => {
    const mailer = new MockMailer();
    await signup(prisma, { email: "gj@example.com" }, { mailer, sendEmail: true });
    const token = await tokenFor("gj@example.com");

    const res = await GET(getReq(token, "application/json"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ verified: false, confirmRequired: true });

    const row = await prisma.waitlist.findUnique({ where: { email: "gj@example.com" } });
    expect(row?.verified).toBe(false);
  });
});

describe("POST /api/verify consumes the token", () => {
  it("a form POST confirms the entry and redirects to the success state", async () => {
    const mailer = new MockMailer();
    await signup(prisma, { email: "p@example.com" }, { mailer, sendEmail: true });
    const token = await tokenFor("p@example.com");

    const res = await POST(postForm(token));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/verified=1/);

    const row = await prisma.waitlist.findUnique({ where: { email: "p@example.com" } });
    expect(row?.verified).toBe(true);
  });

  it("a JSON POST returns verified:true", async () => {
    const mailer = new MockMailer();
    await signup(prisma, { email: "pj@example.com" }, { mailer, sendEmail: true });
    const token = await tokenFor("pj@example.com");

    const res = await POST(postJson(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verified: true, alreadyVerified: false });
  });

  it("a second POST is idempotent (already confirmed), not an error", async () => {
    const mailer = new MockMailer();
    await signup(prisma, { email: "idem@example.com" }, { mailer, sendEmail: true });
    const token = await tokenFor("idem@example.com");

    await POST(postForm(token)); // first confirm

    // JSON re-POST: already verified, no error.
    const again = await POST(postJson(token));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ verified: true, alreadyVerified: true });

    // Browser re-submit: still a success redirect, not the error state.
    const browserAgain = await POST(postForm(token));
    expect(browserAgain.status).toBe(303);
    expect(browserAgain.headers.get("location")).toMatch(/verified=1/);
  });

  it("an unknown token POST redirects to the error state", async () => {
    const res = await POST(postForm("NOPE-NOT-A-TOKEN"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/verified=error/);
  });
});
