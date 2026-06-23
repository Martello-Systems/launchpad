import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listSignups } from "@/lib/waitlist";
import { isAdminAuthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isAdminAuthorized(req.headers)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const take = Math.min(parseInt(req.nextUrl.searchParams.get("take") || "100", 10) || 100, 500);
  const skip = Math.max(parseInt(req.nextUrl.searchParams.get("skip") || "0", 10) || 0, 0);

  const { total, rows } = await listSignups(prisma, { take, skip });
  return NextResponse.json({
    total,
    count: rows.length,
    signups: rows.map((r) => ({
      id: r.id,
      email: r.email,
      referralCode: r.referralCode,
      referralCount: r.referralCount,
      basePosition: r.basePosition,
      position: r.position,
      verified: r.verified,
      createdAt: r.createdAt,
    })),
  });
}
