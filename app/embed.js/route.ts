import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Serves a tiny loader script. Drop this on any page:
//   <script src="https://your-launchpad.example.com/embed.js"
//           data-launchpad
//           data-height="120"></script>
// It replaces itself with a responsive iframe pointing at /embed.
const SCRIPT = `(function () {
  var current = document.currentScript;
  if (!current) return;
  var origin = new URL(current.src).origin;
  var height = current.getAttribute("data-height") || "120";
  var iframe = document.createElement("iframe");
  iframe.src = origin + "/embed";
  iframe.style.width = "100%";
  iframe.style.border = "0";
  iframe.style.height = height + "px";
  iframe.setAttribute("title", "Waitlist signup");
  iframe.setAttribute("loading", "lazy");
  current.parentNode.insertBefore(iframe, current);
})();`;

export async function GET() {
  return new NextResponse(SCRIPT, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
