import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { signup, WaitlistError } from "@/lib/waitlist";
import { getDefaultMailer } from "@/lib/mailer";
import { referralLink } from "@/lib/config";
import { getSignupLimiter, clientIpFromHeaders } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_EMAIL_LEN = 254; // RFC 5321 practical maximum
const MAX_CODE_LEN = 64;

export async function POST(req: NextRequest) {
  // Per-IP rate limit before any work, to blunt spam/abuse on the public route.
  const limiter = getSignupLimiter();
  const ip = clientIpFromHeaders(req.headers);
  const rl = limiter.check(`signup:${ip}`);
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

  try {
    const result = await signup(
      prisma,
      { email: body.email, referredByCode },
      { mailer: getDefaultMailer(), sendEmail: true }
    );
    return NextResponse.json(
      {
        id: result.id,
        email: result.email,
        referralCode: result.referralCode,
        position: result.position,
        verified: result.verified,
        pendingVerification: result.pendingVerification,
        referralLink: referralLink(result.referralCode),
      },
      {
        status: 201,
        headers: {
          "X-RateLimit-Limit": String(rl.limit),
          "X-RateLimit-Remaining": String(rl.remaining),
        },
      }
    );
  } catch (e) {
    if (e instanceof WaitlistError) {
      const status = e.code === "DUPLICATE_EMAIL" ? 409 : 400;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error("signup error", e);
    return NextResponse.json({ error: "Internal error." }, { status: 500 });
  }
}
