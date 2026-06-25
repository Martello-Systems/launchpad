// Shared-store (Postgres) rate limiter, exercised against the real test DB.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./helpers";
import { PrismaRateLimiter } from "../lib/rate-limit";

async function clear(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "RateLimit"');
}

beforeEach(clear);
afterAll(async () => {
  await clear();
  await prisma.$disconnect();
});

describe("PrismaRateLimiter", () => {
  it("allows up to `max` requests for a key, then blocks", async () => {
    const rl = new PrismaRateLimiter(prisma, { max: 3, windowMs: 60_000 });
    expect((await rl.check("k")).allowed).toBe(true); // 1
    expect((await rl.check("k")).allowed).toBe(true); // 2
    const third = await rl.check("k"); // 3
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    const fourth = await rl.check("k"); // over
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("reports remaining correctly", async () => {
    const rl = new PrismaRateLimiter(prisma, { max: 5, windowMs: 60_000 });
    expect((await rl.check("k")).remaining).toBe(4);
    expect((await rl.check("k")).remaining).toBe(3);
  });

  it("isolates keys (different IPs have independent windows)", async () => {
    const rl = new PrismaRateLimiter(prisma, { max: 1, windowMs: 60_000 });
    expect((await rl.check("a")).allowed).toBe(true);
    expect((await rl.check("a")).allowed).toBe(false);
    expect((await rl.check("b")).allowed).toBe(true);
  });

  it("rolls the window over once the stored window has elapsed", async () => {
    const rl = new PrismaRateLimiter(prisma, { max: 1, windowMs: 60_000 });
    expect((await rl.check("k")).allowed).toBe(true);
    expect((await rl.check("k")).allowed).toBe(false);
    // Force the stored window into the past; next check should reset to a fresh one.
    await prisma.$executeRawUnsafe(
      `UPDATE "RateLimit" SET "resetAt" = now() - interval '1 second' WHERE "key" = 'k'`
    );
    const after = await rl.check("k");
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(0); // max=1, just consumed the fresh window
  });

  it("rejects invalid config", () => {
    expect(() => new PrismaRateLimiter(prisma, { max: 0, windowMs: 1000 })).toThrow();
    expect(() => new PrismaRateLimiter(prisma, { max: 5, windowMs: 0 })).toThrow();
  });
});
