"use client";

import { useState } from "react";

/** Starts or resumes the card step for THIS booking (private token only; the amount is calculated on the server). */
export default function AuthorizeCardButton({ token, label }: { token: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function go() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/payments/authorize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.url === "string" && data.url.startsWith("https://")) { window.location.assign(data.url); return; }
      if (data.reason === "already_authorized") { window.location.assign(`/book/confirmation?t=${encodeURIComponent(token)}&card=authorized`); return; }
      setError(data.error ?? "Could not start the card step. You have not been charged. Please try again.");
    } catch {
      setError("Could not reach the server. You have not been charged. Please try again.");
    }
    setBusy(false);
  }
  return (
    <div>
      <button type="button" className="btn btn--primary" onClick={go} disabled={busy}>{busy ? "Opening secure payment…" : label}</button>
      <div role="alert" aria-live="polite">{error && <div className="notice notice--error" style={{ marginTop: "1rem" }}>{error}</div>}</div>
    </div>
  );
}
