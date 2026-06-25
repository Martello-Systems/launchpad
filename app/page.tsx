import SignupForm from "@/components/SignupForm";
import { prisma } from "@/lib/prisma";
import { leaderboard, totalSignups } from "@/lib/waitlist";
import { maskEmail } from "@/lib/format";
import { theme } from "@/theme.config";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ verified?: string }>;
}) {
  const { verified } = await searchParams;

  // Best-effort: if the DB isn't reachable at render time, still show the form.
  let total = 0;
  let board: Awaited<ReturnType<typeof leaderboard>> = [];
  try {
    [total, board] = await Promise.all([totalSignups(prisma), leaderboard(prisma, 5)]);
  } catch {
    /* DB not configured yet: page still renders the signup form */
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-10 px-6 py-16">
      {verified === "1" && (
        <div className="rounded-lg bg-green-50 p-4 text-center text-sm text-green-800">
          Email confirmed. You&apos;re officially on the waitlist. 🎉
        </div>
      )}
      {verified === "error" && (
        <div className="rounded-lg bg-red-50 p-4 text-center text-sm text-red-700">
          That confirmation link is invalid or has already been used.
        </div>
      )}
      <header className="space-y-3 text-center">
        <h1 className="text-4xl font-bold tracking-tight">{theme.title}</h1>
        <p className="text-neutral-600">{theme.tagline}</p>
        {total > 0 && (
          <p className="text-sm text-neutral-500">{total} people already in line.</p>
        )}
      </header>

      <section className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
        <SignupForm />
      </section>

      {board.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Top referrers</h2>
          <ol className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 bg-white">
            {board.map((r, i) => (
              <li key={r.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span>
                  <span className="mr-2 font-mono text-neutral-400">#{i + 1}</span>
                  {maskEmail(r.email)}
                </span>
                <span className="font-medium">{r.referralCount} referrals</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <footer className="text-center text-xs text-neutral-400">
        Powered by{" "}
        <a href={theme.footer.href} className="underline hover:text-neutral-600">
          {theme.footer.label}
        </a>
      </footer>
    </main>
  );
}
