import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { streamSignupsForCsv, type ExportRow } from "@/lib/waitlist";
import { isAdminAuthorized } from "@/lib/auth";
import { csvHeaderLine, csvRowLine, type CsvValue } from "@/lib/csv";
import { getCsvExportBatchSize } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-only CSV export of the full waitlist. Same Bearer ADMIN_TOKEN guard as
// the rest of the admin API. The body is STREAMED row-by-row (paged from the DB
// in batches) so the whole table is never held in memory at once, even for a
// very large list.
const COLUMNS: { key: keyof ExportRow; header: string }[] = [
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

  const batchSize = getCsvExportBatchSize();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(csvHeaderLine(COLUMNS)));
        for await (const row of streamSignupsForCsv(prisma, batchSize)) {
          // CsvValue-typed view of the row for the serializer.
          controller.enqueue(
            encoder.encode(csvRowLine(COLUMNS, row as unknown as Record<string, CsvValue>))
          );
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  const filename = `waitlist-${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
