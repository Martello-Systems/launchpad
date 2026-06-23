# Launchpad 🚀

**A self-hosted viral waitlist in a box.** Signup, referral codes with attribution, position tracking + leaderboard, an admin dashboard, an embeddable widget, and email automation — all in one deployable Next.js app. This is the thing you deploy, not a template you assemble.

- **Referral loops built in.** Every signup gets a unique referral link. Each successful referral moves them up the line.
- **Leaderboard.** Top referrers, ranked, in a single query.
- **Admin dashboard.** Token-guarded view of every signup.
- **Embeddable.** One `<script>` tag drops the signup form onto any site.
- **Email automation.** Confirmation + referral-milestone emails via [Resend](https://resend.com) (mockable; console-only in dev).
- **Tested core.** The waitlist logic (signup, attribution, leaderboard, position rule) is covered by a real test suite against a real Postgres DB.

Stack: **Next.js 15 (App Router) · Prisma · PostgreSQL · Resend · Tailwind · TypeScript**

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
| `NEXT_PUBLIC_APP_URL` | yes | Public base URL, used to build referral links. |
| `REFERRAL_MILESTONE` | no | Referrals per milestone email (default `3`). |

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

### Email
All sends go through the `Mailer` interface (`lib/mailer.ts`). Production uses `ResendMailer` (reads `RESEND_API_KEY`); dev/tests with no key fall back to `ConsoleMailer`; tests inject a capturing mock. Confirmation email fires on signup; a milestone email fires when a referrer reaches each multiple of `REFERRAL_MILESTONE`.

---

## API

| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/signup` | — | Body `{ email, referredByCode? }` → `{ referralCode, position, referralLink }`. `409` on duplicate email. |
| `GET` | `/api/leaderboard?limit=10` | — | Top referrers (emails masked). |
| `GET` | `/api/admin/signups?take=&skip=` | Bearer `ADMIN_TOKEN` | Full signup list with referral counts. |

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

- `/` — public waitlist page: signup form (auto-captures `?ref=CODE`), shows your position + referral link, and a top-referrers list.
- `/admin` — token-prompted admin dashboard listing every signup.
- `/embed` — chrome-free signup form for iframe embedding.

---

## Embed on any site

**Option A — script tag (recommended).** Drop this anywhere; it injects a responsive iframe:

```html
<script src="https://your-launchpad.example.com/embed.js"
        data-launchpad
        data-height="120"></script>
```

**Option B — raw iframe.**

```html
<iframe src="https://your-launchpad.example.com/embed"
        style="width:100%;border:0;height:120px"
        title="Waitlist signup"></iframe>
```

The `/embed` route sets `Content-Security-Policy: frame-ancestors *` so it embeds anywhere. Tighten that to your own domains in `next.config.mjs` for production.

---

## Testing

The core library is tested against a **real Postgres test DB** (it migrates/resets between runs) with the mailer mocked.

```bash
# Point at a throwaway DB; the suite runs prisma migrate deploy in setup.
TEST_DATABASE_URL="postgresql://user:pass@localhost:5432/launchpad_test" npm test
```

Coverage includes: signup + sequential positions, email normalization, duplicate-email and invalid-email handling, referral-code uniqueness, referral attribution + counts, the position-boost rule, leaderboard ordering + tie-breaks + limit, milestone-email firing, and the admin listing.

---

## Deploy

1. Provision a PostgreSQL database; set `DATABASE_URL`.
2. Set `ADMIN_TOKEN`, `NEXT_PUBLIC_APP_URL`, and (for real email) `RESEND_API_KEY` + `EMAIL_FROM`.
3. Apply migrations: `npm run prisma:migrate` (runs `prisma migrate deploy`).
4. Build + start: `npm run build && npm run start`.

Works on any Node host or a serverless platform (Vercel etc.). Prisma client is generated during `npm run build`.

---

## License

MIT © 2026 Martello Systems. See [LICENSE](./LICENSE).
