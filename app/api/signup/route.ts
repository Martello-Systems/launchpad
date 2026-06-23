import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { signup, WaitlistError } from "@/lib/waitlist";
import { getDefaultMailer } from "@/lib/mailer";
import { referralLink } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { email?: string; referredByCode?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.email || typeof body.email !== "string") {
    return NextResponse.json({ error: "Email is required." }, { status: 400 });
  }

  try {
    const result = await signup(
      prisma,
      { email: body.email, referredByCode: body.referredByCode ?? null },
      { mailer: getDefaultMailer(), sendEmail: true }
    );
    return NextResponse.json(
      {
        id: result.id,
        email: result.email,
        referralCode: result.referralCode,
        position: result.position,
        referralLink: referralLink(result.referralCode),
      },
      { status: 201 }
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
