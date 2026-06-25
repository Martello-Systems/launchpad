import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyEmail, WaitlistError } from "@/lib/waitlist";
import { getDefaultMailer } from "@/lib/mailer";
import { getAppUrl } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// SINGLE-USE TOKEN vs. LINK SCANNERS
// ----------------------------------
// The verification link is single-use: confirming consumes (clears) the token.
// But corporate link-scanners (Microsoft SafeLinks, Mimecast, etc.) and browser
// prefetchers fire a GET on the URL the moment the email arrives, BEFORE the real
// user clicks. If GET consumed the token, that automated GET would burn it and
// the human would then see "invalid or already used."
//
// So GET is non-destructive: it renders a tiny "Confirm my spot" page whose
// button POSTs back to this same route. Only POST consumes the token. This keeps
// the link single-use while surviving scanners/prefetchers. A second POST with an
// already-verified token is idempotent ("already confirmed"), never an error.

// Render an HTML page (browser GET, or a non-JSON POST result) with a single,
// optional confirm button. `confirm: true` shows the "Confirm my spot" button
// that POSTs the token back; otherwise it's a terminal status page.
function htmlPage(opts: {
  title: string;
  body: string;
  token?: string;
  confirm?: boolean;
  status?: number;
}): NextResponse {
  const action = `${getAppUrl()}/api/verify`;
  const button =
    opts.confirm && opts.token
      ? `<form method="POST" action="${action}">
      <input type="hidden" name="token" value="${escapeHtml(opts.token)}" />
      <button type="submit" style="display:inline-block;background:#111;color:#fff;border:0;padding:12px 22px;border-radius:6px;font-size:15px;cursor:pointer">Confirm my spot</button>
    </form>`
      : "";
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(opts.title)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 20px;text-align:center;color:#111">
  <h1 style="font-size:22px">${escapeHtml(opts.title)}</h1>
  <p style="color:#555;line-height:1.5">${opts.body}</p>
  ${button}
</body></html>`;
  return new NextResponse(page, {
    status: opts.status ?? 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// GET is NON-DESTRUCTIVE: it never consumes the token. For a browser it renders
// the confirm page; for a programmatic JSON client it just reports that a POST is
// required to consume the token (so scanners that send Accept: application/json
// still don't burn it).
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");

  if (!token.trim()) {
    if (wantsJson) {
      return NextResponse.json(
        { error: "A verification token is required.", code: "INVALID_TOKEN" },
        { status: 400 }
      );
    }
    return htmlPage({
      title: "Invalid link",
      body: "This confirmation link is missing its token. Please use the link from your email.",
      status: 400,
    });
  }

  if (wantsJson) {
    // Programmatic clients (and link scanners that request JSON) are told to POST
    // to actually confirm. The token is NOT consumed here.
    return NextResponse.json({ verified: false, confirmRequired: true, token }, { status: 200 });
  }

  // Browser: render the confirm page. Nothing is consumed until the user submits.
  return htmlPage({
    title: "Confirm your spot",
    body: "Click the button below to confirm your email and lock in your spot on the waitlist.",
    token,
    confirm: true,
  });
}

// POST CONSUMES the token (the only destructive verb). Accepts the token from a
// posted form (the confirm button), a JSON body, or the query string.
export async function POST(req: NextRequest) {
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
  const token = await tokenFromPost(req);

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
    // Redirect a browser form submit to the home page success state. A second
    // submit on an already-verified token lands here too (idempotent success).
    return NextResponse.redirect(`${getAppUrl()}/?verified=1`, { status: 303 });
  } catch (e) {
    if (e instanceof WaitlistError && e.code === "INVALID_TOKEN") {
      if (wantsJson) {
        return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
      }
      return NextResponse.redirect(`${getAppUrl()}/?verified=error`, { status: 303 });
    }
    console.error("verify error", e);
    if (wantsJson) {
      return NextResponse.json({ error: "Internal error." }, { status: 500 });
    }
    return NextResponse.redirect(`${getAppUrl()}/?verified=error`, { status: 303 });
  }
}

// Pull the token from a POST: form-encoded body, JSON body, or query string.
async function tokenFromPost(req: NextRequest): Promise<string> {
  const fromQuery = req.nextUrl.searchParams.get("token");
  if (fromQuery && fromQuery.trim()) return fromQuery;

  const ctype = req.headers.get("content-type") ?? "";
  try {
    if (ctype.includes("application/json")) {
      const body = (await req.json()) as { token?: unknown };
      if (typeof body.token === "string") return body.token;
    } else {
      // application/x-www-form-urlencoded or multipart/form-data (the confirm form).
      const form = await req.formData();
      const t = form.get("token");
      if (typeof t === "string") return t;
    }
  } catch {
    /* no/invalid body: fall through to empty token, which verifyEmail rejects */
  }
  return "";
}
