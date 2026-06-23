import { NextResponse, type NextRequest } from "next/server";
import { embedCsp } from "@/lib/config";

// Apply a configurable Content-Security-Policy (frame-ancestors) to the
// embeddable routes so operators control which origins may iframe the widget.
// Computed at request time so EMBED_ALLOWED_ORIGINS can be changed without a
// rebuild. See lib/config.ts -> embedCsp().
export function middleware(_req: NextRequest) {
  const res = NextResponse.next();
  res.headers.set("Content-Security-Policy", embedCsp());
  return res;
}

export const config = {
  // Only the embeddable surfaces get the frame-ancestors policy.
  matcher: ["/embed", "/embed.js"],
};
