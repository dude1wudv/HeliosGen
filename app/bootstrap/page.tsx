"use client";

import { useEffect, useState } from "react";

export default function BootstrapPage() {
  const [message, setMessage] = useState("Connecting to your workspace…");

  useEffect(() => {
    let cancelled = false;
    const fragment = window.location.hash.slice(1);
    const code = new URLSearchParams(fragment).get("code");
    // Clear the fragment before any asynchronous work. The one-time grant must
    // not remain in browser history, DOM state, or a copied URL.
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    if (!code) {
      queueMicrotask(() => {
        if (!cancelled) setMessage("This workspace link is missing or has already been used.");
      });
      return () => { cancelled = true; };
    }

    (async () => {
      try {
        const response = await fetch("/api/integrations/sub2api/bootstrap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ code }),
        });
        if (!response.ok) throw new Error("bootstrap failed");
        if (!cancelled) window.location.replace("/workflow");
      } catch {
        if (!cancelled) setMessage("This workspace link is invalid or expired. Return to Sub2API and try again.");
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return (
    <main className="flex min-h-full items-center justify-center p-8">
      <section className="max-w-md rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center shadow-2xl">
        <h1 className="mb-3 text-lg font-medium text-white">HeliosGen</h1>
        <p className="text-sm text-white/60">{message}</p>
      </section>
    </main>
  );
}
