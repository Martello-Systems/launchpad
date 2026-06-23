import SignupForm from "@/components/SignupForm";

export const dynamic = "force-dynamic";

// Minimal, chrome-free signup widget intended to be embedded via <iframe>.
// See README "Embed" section. Transparent background so it blends into hosts.
export default function EmbedPage() {
  return (
    <main className="p-4">
      <div className="mx-auto max-w-md">
        <SignupForm compact />
      </div>
    </main>
  );
}
