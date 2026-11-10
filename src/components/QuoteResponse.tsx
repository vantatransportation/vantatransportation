"use client";

import { useState } from "react";

export default function QuoteResponse({ token }: { token: string }) {
  const [state, setState] = useState<{ busy: boolean; done?: "accepted" | "rejected"; error?: string }>({ busy: false });

  async function respond(action: "accept" | "reject") {
    if (state.busy) return;
    setState({ busy: true });
    try {
      const res = await fetch("/api/quote-requests/respond", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, action }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setState({ busy: false, done: data.response });
      else setState({ busy: false, error: data.error ?? "Could not record your response." });
    } catch {
      setState({ busy: false, error: "Could not reach the server. Please try again." });
    }
  }

  if (state.done) {
    return <div className="notice notice--ok" role="status">{state.done === "accepted" ? "Thank you. You accepted the revised quote. We will contact you to finalize your booking." : "Thank you. We have recorded that you declined the revised quote."}</div>;
  }
  return (
    <div>
      <div style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
        <button className="btn btn--primary" onClick={() => respond("accept")} disabled={state.busy}>Accept this quote</button>
        <button className="btn btn--ghost" onClick={() => respond("reject")} disabled={state.busy}>Decline</button>
      </div>
      <div role="alert">{state.error && <div className="notice notice--error">{state.error}</div>}</div>
    </div>
  );
}
