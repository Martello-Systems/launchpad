import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyEmail, WaitlistError } from "@/lib/waitlist";
import { getDefaultMailer } from "@/lib/mailer";
import { getAppUrl } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Confirm a signup via the emailed token. Because users reach this by clicking
// an email link, the happy path redirects to the home page with a flag the UI
// can render; an invalid/expired token redirects with an error flag. The same
// logic is exposed as JSON when the caller sends an Accept JSON header (used by
// tests and programmatic clients).
async function handle(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const token = params.get("token") ?? "";
  const acceptHeader = req.headers.get("accept") ?? "";
  const wantsJson = acceptHeader.includes("application/json");

  try {
    const result = await verifyEmail(prisma, token, {
      mailer: getDefaultMailer(),
      sendEmail: true,
    });
    if (wantsJson) {
      return NextResponse.json(
        { verified: true, alreadyVerified: result.alreadyVerified },
        { status: 200 }
      );
    }
    return NextResponse.redirect(`${getAppUrl()}/?verified=1`);
  } catch (e) {
    if (e instanceof WaitlistError && e.code === "INVALID_TOKEN") {
      if (wantsJson) {
        return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
      }
      return NextResponse.redirect(`${getAppUrl()}/?verified=error`);
    }
    console.error("verify error", e);
    if (wantsJson) {
      return NextResponse.json({ error: "Internal error." }, { status: 500 });
    }
    return NextResponse.redirect(`${getAppUrl()}/?verified=error`);
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

// Allow POST too, for clients that prefer not to verify on a GET.
export async function POST(req: NextRequest) {
  return handle(req);
}
