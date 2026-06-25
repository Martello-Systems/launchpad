import { NextResponse, type NextRequest } from "next/server";
import { embedCsp } from "@/lib/config";

// Baseline security headers applied to EVERY app route (pages, /admin, /api/*),
// plus a special-cased relaxed frame policy for the embeddable widget.
//
// - Everything by default is NOT frameable: `X-Frame-Options: DENY` and a CSP
//   `frame-ancestors 'none'` (belt-and-suspenders; CSP supersedes the legacy
//   header in modern browsers). This blocks clickjacking of the signup page,
//   the admin view, and the API.
// - The embeddable surfaces (/embed, /embed.js) are the deliberate exception:
//   they MUST be iframeable, so instead of DENY they get a configurable
//   `frame-ancestors` allowlist computed at request time from
//   EMBED_ALLOWED_ORIGINS (see lib/config.ts -> embedCsp()).
// - `X-Content-Type-Options: nosniff` and a `Referrer-Policy` go on everything.
export function middleware(req: NextRequest) {
  const res = NextResponse.next();

  // Universal hardening.
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  const path = req.nextUrl.pathname;
  const isEmbed = path === "/embed" || path === "/embed.js";

  if (isEmbed) {
    // Embeddable: a configurable frame-ancestors allowlist, and NO X-Frame-Options
    // (which has no allowlist concept and would block all framing).
    res.headers.set("Content-Security-Policy", embedCsp());
  } else {
    // Everything else: not frameable at all.
    res.headers.set("X-Frame-Options", "DENY");
    res.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  }

  return res;
}

export const config = {
  // Run on all routes except Next.js internals and common static assets, so the
  // baseline headers cover pages, /admin, and the API without touching the build
  // output or the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
