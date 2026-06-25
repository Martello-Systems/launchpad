"use client";

import { useState, useEffect } from "react";

interface SignupSuccess {
  email: string;
  referralCode: string;
  position: number;
  referralLink: string;
  pendingVerification?: boolean;
}

export default function SignupForm({ compact = false }: { compact?: boolean }) {
  const [email, setEmail] = useState("");
  const [ref, setRef] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SignupSuccess | null>(null);
  const [copied, setCopied] = useState(false);

  // Capture ?ref= from the URL so signups attribute correctly.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("ref");
    if (code) setRef(code);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, referredByCode: ref }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong.");
      } else {
        setResult(data as SignupSuccess);
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function copyLink() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  if (result) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg bg-green-50 p-4 text-green-800">
          <p className="font-semibold">You&apos;re in! 🎉</p>
          <p className="text-sm">
            Your position: <strong>#{result.position}</strong>
          </p>
          {result.pendingVerification && (
            <p className="mt-2 text-sm">
              Check your inbox and click the link to confirm your email. Your
              referrals only count once you&apos;re confirmed.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <p className="text-sm text-neutral-600">
            Share your link: every signup moves you up the list:
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              value={result.referralLink}
              className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              onClick={copyLink}
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {loading ? "Joining…" : "Join waitlist"}
        </button>
      </div>
      {ref && !compact && (
        <p className="text-xs text-neutral-500">Referred by code: {ref}</p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
