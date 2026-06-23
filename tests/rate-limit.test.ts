import { describe, it, expect } from "vitest";
import {
  RateLimiter,
  clientIpFromHeaders,
  getSignupRateLimitConfig,
} from "../lib/rate-limit";

describe("RateLimiter", () => {
  it("allows requests up to the limit, then blocks", () => {
    const rl = new RateLimiter({ max: 3, windowMs: 1000 });
    const t0 = 1_000_000;
    expect(rl.check("k", t0).allowed).toBe(true); // 1
    expect(rl.check("k", t0).allowed).toBe(true); // 2
    expect(rl.check("k", t0).allowed).toBe(true); // 3
    const blocked = rl.check("k", t0); // 4 -> over
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("reports remaining correctly", () => {
    const rl = new RateLimiter({ max: 5, windowMs: 1000 });
    const t0 = 2_000_000;
    expect(rl.check("k", t0).remaining).toBe(4);
    expect(rl.check("k", t0).remaining).toBe(3);
  });

  it("resets after the window elapses", () => {
    const rl = new RateLimiter({ max: 2, windowMs: 1000 });
    const t0 = 3_000_000;
    expect(rl.check("k", t0).allowed).toBe(true);
    expect(rl.check("k", t0).allowed).toBe(true);
    expect(rl.check("k", t0).allowed).toBe(false); // over within window
    // After the window: allowed again.
    const t1 = t0 + 1001;
    expect(rl.check("k", t1).allowed).toBe(true);
    expect(rl.check("k", t1).allowed).toBe(true);
    expect(rl.check("k", t1).allowed).toBe(false);
  });

  it("isolates keys (different IPs have independent windows)", () => {
    const rl = new RateLimiter({ max: 1, windowMs: 1000 });
    const t0 = 4_000_000;
    expect(rl.check("a", t0).allowed).toBe(true);
    expect(rl.check("a", t0).allowed).toBe(false);
    // Different key unaffected.
    expect(rl.check("b", t0).allowed).toBe(true);
  });

  it("manual reset clears a key", () => {
    const rl = new RateLimiter({ max: 1, windowMs: 1000 });
    const t0 = 5_000_000;
    expect(rl.check("k", t0).allowed).toBe(true);
    expect(rl.check("k", t0).allowed).toBe(false);
    rl.reset("k");
    expect(rl.check("k", t0).allowed).toBe(true);
  });

  it("rejects invalid config", () => {
    expect(() => new RateLimiter({ max: 0, windowMs: 1000 })).toThrow();
    expect(() => new RateLimiter({ max: 5, windowMs: 0 })).toThrow();
  });
});

describe("clientIpFromHeaders", () => {
  it("prefers the first x-forwarded-for entry", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    expect(clientIpFromHeaders(h)).toBe("203.0.113.7");
  });
  it("falls back to x-real-ip", () => {
    const h = new Headers({ "x-real-ip": "198.51.100.9" });
    expect(clientIpFromHeaders(h)).toBe("198.51.100.9");
  });
  it("returns 'unknown' when no IP header is present", () => {
    expect(clientIpFromHeaders(new Headers())).toBe("unknown");
  });
});

describe("getSignupRateLimitConfig", () => {
  it("reads RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS from env", () => {
    const prevMax = process.env.RATE_LIMIT_MAX;
    const prevWin = process.env.RATE_LIMIT_WINDOW_MS;
    process.env.RATE_LIMIT_MAX = "11";
    process.env.RATE_LIMIT_WINDOW_MS = "22000";
    const cfg = getSignupRateLimitConfig();
    expect(cfg.max).toBe(11);
    expect(cfg.windowMs).toBe(22000);
    // restore
    if (prevMax === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = prevMax;
    if (prevWin === undefined) delete process.env.RATE_LIMIT_WINDOW_MS;
    else process.env.RATE_LIMIT_WINDOW_MS = prevWin;
  });

  it("falls back to safe defaults on missing/invalid env", () => {
    const prevMax = process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_MAX;
    const cfg = getSignupRateLimitConfig();
    expect(cfg.max).toBe(5);
    expect(cfg.windowMs).toBe(60_000);
    if (prevMax !== undefined) process.env.RATE_LIMIT_MAX = prevMax;
  });
});
