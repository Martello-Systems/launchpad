import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listSignups, totalSignups } from "@/lib/waitlist";
import { isAdminAuthorized } from "@/lib/auth";
import { toCsv, type CsvValue } from "@/lib/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-only CSV export of the full waitlist. Same Bearer ADMIN_TOKEN guard as
// the rest of the admin API. Returns text/csv as a downloadable attachment.
const COLUMNS: { key: string; header: string }[] = [
  { key: "email", header: "email" },
  { key: "referralCode", header: "referral_code" },
  { key: "verified", header: "verified" },
  { key: "referralCount", header: "verified_referrals" },
  { key: "basePosition", header: "base_position" },
  { key: "position", header: "effective_position" },
  { key: "createdAt", header: "created_at" },
];

export async function GET(req: NextRequest) {
  if (!isAdminAuthorized(req.headers)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  // Pull every row (admin export). totalSignups bounds the single page we fetch.
  const total = await totalSignups(prisma);
  const { rows } = await listSignups(prisma, { take: total, skip: 0 });

  const records: Record<string, CsvValue>[] = rows.map((r) => ({
    email: r.email,
    referralCode: r.referralCode,
    verified: r.verified,
    referralCount: r.referralCount,
    basePosition: r.basePosition,
    position: r.position,
    createdAt: r.createdAt,
  }));

  const csv = toCsv(COLUMNS, records);
  const filename = `waitlist-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
