// In-memory fixed-window rate limiter.
//
// SCOPE / LIMITATION (documented intentionally):
//   This limiter keeps its counters in the Node process memory. It is correct
//   and sufficient for a SINGLE self-hosted instance (the common deployment for
//   this app). If you run multiple instances / serverless lambdas behind a load
//   balancer, each instance keeps its own window, so the effective global limit
//   is roughly (limit × instanceCount). For multi-instance setups, put a shared
//   store (Redis/Upstash) behind this same interface. We deliberately avoid
//   adding that infra to v1, see README "Limitations".
//
// Algorithm: fixed window per key. Each key tracks a count and the window's
// reset timestamp. When the window elapses, the count resets. This is simpler
// and cheaper than a sliding window and is the right trade-off for abuse/spam
// prevention on a public signup endpoint.

import { getRateLimitStore } from "./config";

export interface RateLimitConfig {
  /** Max allowed requests per key within the window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  /** Whether this request is allowed (true) or should be rejected (false). */
  allowed: boolean;
  /** Requests remaining in the current window (>= 0). */
  remaining: number;
  /** Unix epoch ms when the current window resets. */
  resetAt: number;
  /** Seconds until reset, for a Retry-After header. */
  retryAfterSeconds: number;
  /** The configured limit (for X-RateLimit-Limit). */
  limit: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * A small, dependency-free fixed-window limiter. One instance per logical
 * endpoint. Buckets are pruned lazily on access plus on a periodic sweep so the
 * map can't grow unbounded under a stream of unique keys.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private config: RateLimitConfig;
  private lastSweep = 0;

  constructor(config: RateLimitConfig) {
    if (!Number.isFinite(config.max) || config.max <= 0) {
      throw new Error("RateLimiter: max must be a positive number");
    }
    if (!Number.isFinite(config.windowMs) || config.windowMs <= 0) {
      throw new Error("RateLimiter: windowMs must be a positive number");
    }
    this.config = config;
  }

  /**
   * Record a hit for `key` and report whether it is allowed. `now` is injectable
   * for deterministic tests.
   */
  check(key: string, now: number = Date.now()): RateLimitResult {
    this.maybeSweep(now);

    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + this.config.windowMs };
      this.buckets.set(key, bucket);
    }

    const allowed = bucket.count < this.config.max;
    if (allowed) bucket.count++;

    const remaining = Math.max(0, this.config.max - bucket.count);
    return {
      allowed,
      remaining,
      resetAt: bucket.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      limit: this.config.max,
    };
  }

  /** Drop a key's window (used in tests). */
  reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }

  /** Remove expired buckets at most once per window to bound memory. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < this.config.windowMs) return;
    this.lastSweep = now;
    for (const [k, b] of this.buckets) {
      if (now >= b.resetAt) this.buckets.delete(k);
    }
  }
}

/**
 * Shared-store fixed-window limiter backed by Postgres (the `RateLimit` table)
 * via Prisma. Unlike RateLimiter, this is correct across multiple instances /
 * serverless lambdas because the counter lives in the database, not process
 * memory. Opt in with RATE_LIMIT_STORE=postgres.
 *
 * The window is advanced atomically in a single INSERT ... ON CONFLICT so two
 * concurrent requests can't both reset or double-count the window. Clock math
 * uses the database's now() for consistency across instances.
 */
export class PrismaRateLimiter {
  private config: RateLimitConfig;
  // Structural type: anything exposing Prisma's $queryRaw tag works (the real
  // client, a tx client, or a test double), without importing @prisma/client.
  private db: {
    $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  };

  constructor(
    db: PrismaRateLimiter["db"],
    config: RateLimitConfig
  ) {
    if (!Number.isFinite(config.max) || config.max <= 0) {
      throw new Error("PrismaRateLimiter: max must be a positive number");
    }
    if (!Number.isFinite(config.windowMs) || config.windowMs <= 0) {
      throw new Error("PrismaRateLimiter: windowMs must be a positive number");
    }
    this.config = config;
    this.db = db;
  }

  async check(key: string): Promise<RateLimitResult> {
    const windowSec = this.config.windowMs / 1000;
    // Bump the counter, rolling the window over when the stored one has expired.
    const rows = await this.db.$queryRaw<{ count: number | bigint; resetAt: Date }[]>`
      INSERT INTO "RateLimit" ("key", "count", "resetAt", "updatedAt")
      VALUES (${key}, 1, now() + (${windowSec} * interval '1 second'), now())
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RateLimit"."resetAt" <= now() THEN 1 ELSE "RateLimit"."count" + 1 END,
        "resetAt" = CASE WHEN "RateLimit"."resetAt" <= now()
                         THEN now() + (${windowSec} * interval '1 second')
                         ELSE "RateLimit"."resetAt" END,
        "updatedAt" = now()
      RETURNING "count", "resetAt";
    `;
    const row = rows[0];
    const count = Number(row.count);
    const resetAt = new Date(row.resetAt).getTime();
    const now = Date.now();
    const allowed = count <= this.config.max;
    return {
      allowed,
      remaining: Math.max(0, this.config.max - count),
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      limit: this.config.max,
    };
  }
}

/** Read limiter config from env with safe defaults. */
export function getSignupRateLimitConfig(): RateLimitConfig {
  const max = parseInt(process.env.RATE_LIMIT_MAX || "", 10);
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "", 10);
  return {
    max: Number.isFinite(max) && max > 0 ? max : 5,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60_000,
  };
}

/**
 * Best-effort client IP extraction from common proxy headers, falling back to a
 * fixed bucket so a missing IP still gets limited (rather than bypassing).
 */
export function clientIpFromHeaders(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    // First entry is the original client.
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

// Process-wide singleton for the signup endpoint. Reused across requests so the
// window persists for the life of the instance.
let signupLimiter: RateLimiter | null = null;

export function getSignupLimiter(): RateLimiter {
  if (!signupLimiter) {
    signupLimiter = new RateLimiter(getSignupRateLimitConfig());
  }
  return signupLimiter;
}

// Test seam: reset the singleton so a test can pick up fresh env config.
export function __resetSignupLimiterForTests(): void {
  signupLimiter = null;
}

/**
 * Check the signup rate limit using whichever store is configured
 * (RATE_LIMIT_STORE): the shared Postgres limiter when "postgres", otherwise the
 * in-memory singleton. Always returns a Promise so callers don't care which.
 */
export async function checkSignupRateLimit(
  db: PrismaRateLimiter["db"] | null,
  key: string
): Promise<RateLimitResult> {
  if (getRateLimitStore() === "postgres" && db) {
    return new PrismaRateLimiter(db, getSignupRateLimitConfig()).check(key);
  }
  return getSignupLimiter().check(key);
}
