# Launchpad 🚀

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE) [![Built by Martello Systems](https://img.shields.io/badge/built%20by-Martello%20Systems-0b0b14)](https://martellosystems.com)

**A self-hosted viral waitlist in a box.** Signup, referral codes with attribution, position tracking + leaderboard, an admin dashboard, an embeddable widget, and email automation, all in one deployable Next.js app. This is the thing you deploy, not a template you assemble.

- **Referral loops built in.** Every signup gets a unique referral link. Each successful (verified) referral moves them up the line.
- **Double opt-in.** Signups confirm their email via a verification link; only verified referrals count (anti-gaming). Toggle off if you don't want it.
- **Leaderboard.** Top referrers, ranked, in a single query.
- **Admin dashboard.** Token-guarded view of every signup.
- **Embeddable.** One `<script>` tag drops the signup form onto any site, with a configurable `frame-ancestors` allowlist.
- **Rate-limited signup.** Per-IP limiter on the public endpoint to blunt spam/abuse, configurable via env.
- **Email automation.** Verification + confirmation + referral-milestone emails via [Resend](https://resend.com) (mockable; console-only in dev).
- **Tested.** 94 tests against a real Postgres DB: signup, attribution, leaderboard, position rule, verification flow (incl. scanner-safe `GET`/`POST`-consume + idempotent re-confirm) + token expiry, anti-enumeration (body **and** timing), app-wide security headers, in-memory + Postgres rate limiters (incl. expired-row pruning), streamed CSV export (newest-first, order-stable), and embed CSP. CI runs them on every push.

Stack: **Next.js 15 (App Router) · Prisma · PostgreSQL · Resend · Tailwind · TypeScript**

> **Demo:** _(live demo link / screenshot coming soon)_

---

## Quick start

```bash
git clone <your-fork> launchpad && cd launchpad
npm install
cp .env.example .env        # then edit .env (see below)
npm run prisma:migrate      # applies migrations to your DATABASE_URL
npm run dev                 # http://localhost:3000
```

### Environment variables (`.env`)

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string for Prisma. |
| `TEST_DATABASE_URL` | tests only | A throwaway DB the test suite migrates/resets. |
| `RESEND_API_KEY` | prod email | Resend API key. **Leave blank in dev** to use the console mailer (logs instead of sending). |
| `EMAIL_FROM` | prod email | Verified Resend sender, e.g. `Launchpad <waitlist@yourdomain.com>`. |
| `ADMIN_TOKEN` | yes (admin) | Bearer token guarding `/admin` and the admin API. **Set a long random value.** |
| `NEXT_PUBLIC_APP_URL` | yes | Public base URL, used to build referral + verification links. |
| `REFERRAL_MILESTONE` | no | Referrals per milestone email (default `3`). |
| `REQUIRE_EMAIL_VERIFICATION` | no | Double opt-in on/off (default `true`). When `false`, every signup counts immediately. |
| `VERIFY_TOKEN_TTL_HOURS` | no | How long a verification link stays valid (default `48`). `0` disables expiry. |
| `RATE_LIMIT_MAX` | no | Max signup attempts per IP per window (default `5`). |
| `RATE_LIMIT_WINDOW_MS` | no | Rate-limit window in ms (default `60000`). |
| `RATE_LIMIT_STORE` | no | Rate-limit backing store: `memory` (default) or `postgres` (shared across instances). |
| `EMBED_ALLOWED_ORIGINS` | no | Origins allowed to iframe the widget (default `'self'`). See [Embed](#embed-on-any-site). |

Secrets live only in `.env` (gitignored). Only `.env.example` (placeholders) is committed.

---

## How it works

### Data model
A single `Waitlist` table (`prisma/schema.prisma`): `email` (unique), `referralCode` (unique), `position`, `verified`, `createdAt`, and a nullable self-referential `referredById` for attribution.

### Position rule (documented + tested)
- On signup you're appended to the end: your **base position** = current signup count + 1 (1-indexed).
- A **successful referral** = someone signs up using your referral code.
- Each successful referral boosts your **effective position** up by `POSITION_BOOST_PER_REFERRAL` (default `1`), floored at 1:

  ```
  effectivePosition = max(1, basePosition − referralCount × BOOST)
  ```

- Base position is stored once and never mutated; the boost is applied on read. This keeps join-order as an audit trail and the rule fully deterministic. See `lib/waitlist.ts`.

### Leaderboard
Top referrers ranked by referral count (desc), ties broken by earliest join. One grouped query for counts. See `leaderboard()` in `lib/waitlist.ts`.

### Email verification (double opt-in) & the referral-credit rule
With `REQUIRE_EMAIL_VERIFICATION=true` (the default):

1. A signup is created **unverified** (`pending`) with a single-use `verifyToken`, and a verification email is sent.
2. Clicking the link opens `GET /api/verify?token=…`, which **renders a lightweight "Confirm my spot" page** — it does **not** consume the token. Pressing the button **`POST`s** back to the same route, which marks the entry **verified** and sends the welcome confirmation email. The token is consumed only on `POST`. (Why: corporate link-scanners like Microsoft SafeLinks/Mimecast and browser prefetchers fire a `GET` on the link before the human clicks; if `GET` consumed the token they'd burn it and the real user would see "already used." Making `GET` non-destructive fixes that.)
3. **Idempotent confirm.** A second `POST` with an already-confirmed token returns "already confirmed" (idempotent success), never an error — so a double-click or a refresh of the confirm page is harmless.
4. **Referral-credit rule:** a referral only counts toward the referrer's leaderboard rank, position boost, and milestone emails **once the referred signup is verified.** Unverified (pending) referrals are ignored. This prevents gaming the loop with throwaway/unconfirmable addresses.

Set `REQUIRE_EMAIL_VERIFICATION=false` to skip this: signups are created verified, the welcome email fires immediately, and every referral counts at once.

**Verification links expire.** A verification token is single-use (it can only ever flip an entry pending → verified once; the welcome/milestone side effects fire exactly once) **and** time-limited: it stops working after `VERIFY_TOKEN_TTL_HOURS` (default 48h). An expired link is rejected exactly like an invalid one; signing up again simply issues a fresh link.

### No email enumeration
`POST /api/signup` is designed so its response can't be used to discover which addresses are on the list. With double opt-in on (the default), it returns the **same** generic `200 { ok, pendingVerification: true }` body whether the email is brand-new, already pending, or already verified, and never echoes per-account data (no code, position, or link). Behind the scenes it still does the right thing: a new email gets a verification link, a pending one gets its link re-sent (refreshed if expired), and an already-verified one gets a benign "you're already on the list" note. (With verification **off**, a genuinely new signup returns its referral details inline for instant sharing, so that legacy mode is less opaque by design.)

The endpoint also closes the **timing** side-channel: a brand-new signup does more work (insert a row, mint a code) than a duplicate (re-send a benign email), so it would otherwise be faster/slower. Every enumeration-relevant response is padded up to a fixed floor (`SIGNUP_MIN_RESPONSE_MS`, default 250ms) so new vs. existing emails are indistinguishable by latency as well as by body.

### Email plumbing
All sends go through the `Mailer` interface (`lib/mailer.ts`). Production uses `ResendMailer` (reads `RESEND_API_KEY`); dev/tests with no key fall back to `ConsoleMailer`; tests inject a capturing mock. A milestone email fires when a referrer reaches each multiple of `REFERRAL_MILESTONE` **verified** referrals.

### Rate limiting
The public `POST /api/signup` endpoint is rate-limited per client IP using a fixed-window limiter (`lib/rate-limit.ts`), configured by `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`. Over-limit requests get `429` with `Retry-After`. The default store is in-memory (per-instance); set `RATE_LIMIT_STORE=postgres` to use a shared `RateLimit` table so the limit is enforced globally across instances / serverless lambdas (the window is advanced atomically in a single `INSERT … ON CONFLICT`). The Postgres store **prunes expired rows** opportunistically (and exposes `pruneExpired()` for a cron/cleanup path) so the table can't grow unbounded under a stream of unique keys.

### Theming
Rebranding lives in two small places, no component edits required:

- **`theme.config.ts`** (repo root) — the product name, page title, tagline, footer link, and the accent color used in emails.
- **`app/globals.css`** `:root` — three CSS variables (`--brand`, `--brand-hover`, `--brand-fg`) that drive the Tailwind `brand` / `brand-hover` / `brand-fg` color tokens every call-to-action uses.

Change those and the public page, admin, embed widget, `<title>`/metadata, and transactional emails all follow.

---

## API

| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/signup` | rate-limited | Body `{ email, referredByCode? }`. With double opt-in on (default), always returns the **same** `200 { ok, pendingVerification: true }` whether or not the email already exists (anti-enumeration, see below). With verification off, a fresh signup returns `{ ok, referralCode, position, referralLink }`. `429` over the rate limit. |
| `GET` | `/api/verify?token=…` | none | **Non-destructive** (scanner/prefetch-safe): renders a "Confirm my spot" page that `POST`s the token back. Returns `{ confirmRequired: true }` for `Accept: application/json`. Never consumes the token. |
| `POST` | `/api/verify` | none | Consumes the token: marks the signup verified. Form submit redirects to `/?verified=1` (or `?verified=error`); returns JSON when `Accept: application/json`. A repeat `POST` is idempotent ("already confirmed"). Expired tokens are rejected like invalid ones. |
| `GET` | `/api/leaderboard?limit=10` | none | Top referrers by **verified** referrals (emails masked). |
| `GET` | `/api/admin/signups?take=&skip=` | Bearer `ADMIN_TOKEN` | Full signup list with referral counts + verified status. |
| `GET` | `/api/admin/export` | Bearer `ADMIN_TOKEN` | Full waitlist as a downloadable **CSV** (`text/csv` attachment), **streamed in batches** so the whole table is never held in memory. The admin page has an "Export CSV" button. |

Example:

```bash
curl -X POST localhost:3000/api/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com"}'

curl localhost:3000/api/admin/signups \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Pages

- `/`: public waitlist page: signup form (auto-captures `?ref=CODE`), shows your position + referral link, and a top-referrers list.
- `/admin`: token-prompted admin dashboard listing every signup.
- `/embed`: chrome-free signup form for iframe embedding.

---

## Embed on any site

**Option A: script tag (recommended).** Drop this anywhere; it injects a responsive iframe:

```html
<script src="https://your-launchpad.example.com/embed.js"
        data-launchpad
        data-height="120"></script>
```

**Option B: raw iframe.**

```html
<iframe src="https://your-launchpad.example.com/embed"
        style="width:100%;border:0;height:120px"
        title="Waitlist signup"></iframe>
```

**Controlling who may embed.** The `/embed` and `/embed.js` routes get a `Content-Security-Policy: frame-ancestors …` header, computed at request time from `EMBED_ALLOWED_ORIGINS` (see `middleware.ts` + `lib/config.ts`):

- **unset / empty** → `frame-ancestors 'self'` (safe default: only your own deployment may iframe it).
- **`EMBED_ALLOWED_ORIGINS="https://acme.com https://www.acme.com"`** → `frame-ancestors 'self' https://acme.com https://www.acme.com`.
- **`EMBED_ALLOWED_ORIGINS="*"`** → `frame-ancestors *` (any site, opt-in only).

Because it's read at request time, you can change the allowlist without rebuilding.

### Security headers (app-wide)

`middleware.ts` applies a baseline set of security headers to **every** route:

- `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin` everywhere.
- The signup page, `/admin`, and all `/api/*` are **not** frameable: `X-Frame-Options: DENY` plus CSP `frame-ancestors 'none'` (anti-clickjacking).
- The only exception is the embeddable widget (`/embed`, `/embed.js`), which is meant to be iframed and instead gets the configurable `frame-ancestors` allowlist described above.

---

## Testing

The core library is tested against a **real Postgres test DB** (it migrates/resets between runs) with the mailer mocked.

```bash
# Point at a throwaway DB; the suite runs prisma migrate deploy in setup.
TEST_DATABASE_URL="postgresql://user:pass@localhost:5432/launchpad_test" npm test
```

Coverage (94 tests) includes: signup + sequential positions, email normalization, duplicate/invalid-email handling, referral-code uniqueness, referral attribution + counts, the position-boost rule, leaderboard ordering + tie-breaks + limit, milestone-email firing, the admin listing, the **rate limiter** (in-memory and the Postgres shared store: under/over limit, window reset, key isolation, **expired-row pruning** + grace period), the **embed CSP** header (default/allowlist/wildcard + middleware) and the **app-wide security headers** (nosniff, Referrer-Policy, non-frameable pages/API vs. embeddable widget), the full **double-opt-in verification flow** (pending state, verify token, idempotent re-confirm, verified-only referral credit) including the route-level guarantee that a **bare `GET` never consumes the token** and only `POST` does, **token TTL** (expired links rejected), **anti-enumeration** (identical signup response **shape and timing** for new vs existing emails), the **shared `maskEmail`** helper, and **CSV** serialization (quoting, formula-injection defense) + the **streamed batch export**.

### Continuous integration
`.github/workflows/ci.yml` spins up a Postgres 16 service, installs deps, runs `prisma generate` + `migrate deploy`, then lint, typecheck, the test suite, and `npm run build` on every push/PR.

---

## Limitations

- **Rate limiting defaults to in-memory (per-instance).** Correct for a single self-hosted instance (the common case); each instance keeps its own window. For multi-instance / serverless deployments set `RATE_LIMIT_STORE=postgres` to enforce the limit globally via the shared `RateLimit` table.
- **Email masking on the public leaderboard** is best-effort obfuscation, not anonymization.
- **Anti-enumeration applies to the double-opt-in (default) mode.** With `REQUIRE_EMAIL_VERIFICATION=false`, a brand-new signup returns its referral details inline while a duplicate returns a generic OK, so that legacy mode reveals a little more. Keep verification on (the default) for the strongest posture.
- **Single-table waitlist model:** no multi-project/multi-tenant support (roadmap, and the biggest future lever).

---

## Deploy

1. Provision a PostgreSQL database; set `DATABASE_URL`.
2. Set `ADMIN_TOKEN`, `NEXT_PUBLIC_APP_URL`, and (for real email) `RESEND_API_KEY` + `EMAIL_FROM`.
3. Apply migrations: `npm run prisma:migrate` (runs `prisma migrate deploy`).
4. Build + start: `npm run build && npm run start`.

Works on any Node host or a serverless platform (Vercel etc.). Prisma client is generated during `npm run build`.

---

## License

Apache-2.0 © 2026 Martello Systems. See [LICENSE](./LICENSE).

---

<sub>Built by **Martello Systems**. We design and ship AI-driven software.
Part of the Martello open-source dev-tools family.</sub>

---

## Built by Martello Systems

`launchpad` is part of the open-source toolkit from **[Martello Systems](https://martellosystems.com)**. We ship AI-built software, spec to delivery in days. If this saved you time, come [see what we do](https://martellosystems.com).

Licensed under the [Apache License 2.0](LICENSE).
