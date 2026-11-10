"use client";

import { useState } from "react";

/** Asks the server for a Checkout session for this booking, then sends the customer to Stripe's hosted page. */
export default function PayButton({ token, label }: { token: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function pay() {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/payments/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.url === "string" && data.url.startsWith("https://")) { window.location.href = data.url; return; }
      setError(data.error ?? "Could not start the payment. Please try again.");
    } catch {
      setError("Could not reach the server. Please try again.");
    }
    setBusy(false);
  }
  return (
    <div>
      <button type="button" className="btn btn--primary" onClick={pay} disabled={busy}>{busy ? "Opening secure payment…" : label}</button>
      <div role="alert" aria-live="polite">{error && <div className="notice notice--error" style={{ marginTop: "1rem" }}>{error}</div>}</div>
    </div>
  );
}
