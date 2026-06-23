import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { leaderboard } from "@/lib/waitlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mask an email for public display: a***@domain.com
function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  const head = user.slice(0, 1);
  return `${head}${"*".repeat(Math.max(2, user.length - 1))}@${domain}`;
}

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
