"use client";

import { useState } from "react";

interface Signup {
  id: string;
  email: string;
  referralCode: string;
  referralCount: number;
  position: number;
  basePosition: number;
  verified: boolean;
  createdAt: string;
}

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{ total: number; signups: Signup[] } | null>(null);

  async function load(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/signups?take=500", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        setError("Invalid admin token.");
        setData(null);
      } else if (!res.ok) {
        setError("Failed to load.");
      } else {
        setData(await res.json());
      }
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="mb-6 text-2xl font-bold">Waitlist admin</h1>

      <form onSubmit={load} className="mb-8 flex gap-2">
        <input
          type="password"
          placeholder="Admin token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load"}
        </button>
      </form>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {data && (
        <div className="space-y-4">
          <p className="text-sm text-neutral-600">{data.total} total signups</p>
          <div className="overflow-x-auto rounded-lg border border-neutral-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-100 text-neutral-600">
                <tr>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">Referrals</th>
                  <th className="px-3 py-2">Position</th>
                  <th className="px-3 py-2">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {data.signups.map((s) => (
                  <tr key={s.id}>
                    <td className="px-3 py-2">{s.email}</td>
                    <td className="px-3 py-2 font-mono">{s.referralCode}</td>
                    <td className="px-3 py-2">{s.referralCount}</td>
                    <td className="px-3 py-2">#{s.position}</td>
                    <td className="px-3 py-2 text-neutral-500">
                      {new Date(s.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
