import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resendForExistingEmail, signup, WaitlistError } from "@/lib/waitlist";
import { getDefaultMailer } from "@/lib/mailer";
import { isEmailVerificationEnabled, referralLink, getSignupMinResponseMs } from "@/lib/config";
import { checkSignupRateLimit, clientIpFromHeaders } from "@/lib/rate-limit";
import { enforceMinDuration } from "@/lib/timing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_EMAIL_LEN = 254; // RFC 5321 practical maximum
const MAX_CODE_LEN = 64;

// Single generic "we sent you an email" body. Returned for BOTH a brand-new
// pending signup AND a signup attempt on an already-registered email, so the
// response can't be used to discover which addresses are on the list
// (anti-enumeration). It carries no per-account data on purpose.
const PENDING_MESSAGE =
  "Almost there — check your inbox for a link to confirm your spot. If this email is already on the list, nothing changes.";

function pendingResponse(rl: { limit: number; remaining: number }) {
  return NextResponse.json(
    { ok: true, pendingVerification: true, message: PENDING_MESSAGE },
    {
      status: 200,
      headers: {
        "X-RateLimit-Limit": String(rl.limit),
        "X-RateLimit-Remaining": String(rl.remaining),
      },
    }
  );
}

export async function POST(req: NextRequest) {
  // Per-IP rate limit before any work, to blunt spam/abuse on the public route.
  const ip = clientIpFromHeaders(req.headers);
  const rl = await checkSignupRateLimit(prisma, `signup:${ip}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly." },
      {
        status: 429,
        headers: {
          "Retry-After": String(rl.retryAfterSeconds),
          "X-RateLimit-Limit": String(rl.limit),
          "X-RateLimit-Remaining": String(rl.remaining),
          "X-RateLimit-Reset": String(Math.ceil(rl.resetAt / 1000)),
        },
      }
    );
  }

  let body: { email?: unknown; referredByCode?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validate shapes explicitly (defense in depth; Prisma parameterizes anyway).
  if (typeof body.email !== "string" || body.email.trim().length === 0) {
    return NextResponse.json({ error: "Email is required." }, { status: 400 });
  }
  if (body.email.length > MAX_EMAIL_LEN) {
    return NextResponse.json({ error: "Email is too long." }, { status: 400 });
  }
  let referredByCode: string | null = null;
  if (body.referredByCode != null) {
    if (typeof body.referredByCode !== "string" || body.referredByCode.length > MAX_CODE_LEN) {
      return NextResponse.json({ error: "Invalid referral code." }, { status: 400 });
    }
    referredByCode = body.referredByCode;
  }

  // Start the response-timing clock here, around the email-existence-dependent
  // work (signup insert vs. duplicate resend). Every enumeration-relevant 200
  // below is padded up to the same floor so new vs existing emails are
  // indistinguishable by latency. See lib/timing.ts.
  const started = Date.now();
  const minMs = getSignupMinResponseMs();

  const mailer = getDefaultMailer();
  try {
    const result = await signup(
      prisma,
      { email: body.email, referredByCode },
      { mailer, sendEmail: true }
    );

    // Double opt-in (default): respond with the generic pending body — no
    // per-account data — so it's identical to the duplicate-email case below.
    if (result.pendingVerification) {
      await enforceMinDuration(started, minMs);
      return pendingResponse(rl);
    }

    // Verification disabled: signup is immediate, so it's safe (and useful) to
    // return the shareable referral details inline.
    await enforceMinDuration(started, minMs);
    return NextResponse.json(
      {
        ok: true,
        id: result.id,
        email: result.email,
        referralCode: result.referralCode,
        position: result.position,
        verified: result.verified,
        pendingVerification: false,
        referralLink: referralLink(result.referralCode),
      },
      {
        status: 200,
        headers: {
          "X-RateLimit-Limit": String(rl.limit),
          "X-RateLimit-Remaining": String(rl.remaining),
        },
      }
    );
  } catch (e) {
    if (e instanceof WaitlistError) {
      if (e.code === "DUPLICATE_EMAIL") {
        // Email already exists: do NOT reveal that. Re-send the appropriate
        // benign email (verification resend or a gentle "already on the list"
        // note) as a side effect, but choose the RESPONSE shape purely by the
        // verification MODE — never by the existing entry's state — so it's
        // identical to a brand-new signup (anti-enumeration).
        await resendForExistingEmail(prisma, body.email as string, {
          mailer,
          sendEmail: true,
        });
        if (isEmailVerificationEnabled()) {
          await enforceMinDuration(started, minMs);
          return pendingResponse(rl);
        }
        // Verification disabled and already on the list: a generic OK with no
        // per-account data (we can't echo the existing account's code/position).
        await enforceMinDuration(started, minMs);
        return NextResponse.json(
          { ok: true, pendingVerification: false, message: "You're on the list." },
          {
            status: 200,
            headers: {
              "X-RateLimit-Limit": String(rl.limit),
              "X-RateLimit-Remaining": String(rl.remaining),
            },
          }
        );
      }
      // INVALID_EMAIL and friends are not existence oracles — surface them.
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    console.error("signup error", e);
    return NextResponse.json({ error: "Internal error." }, { status: 500 });
  }
}
