import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { leaderboard } from "@/lib/waitlist";
import { maskEmail } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitParam || "10", 10) || 10, 1), 100);

  const rows = await leaderboard(prisma, limit);
  return NextResponse.json({
    leaderboard: rows.map((r, i) => ({
      rank: i + 1,
      email: maskEmail(r.email),
      referralCount: r.referralCount,
      position: r.position,
    })),
  });
}
