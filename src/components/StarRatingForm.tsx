"use client";

import { useState } from "react";

/** Shared 1-5 star form (customer -> driver and driver -> customer). The server re-checks eligibility and duplicates; this only collects input. */
export default function StarRatingForm({ title, help, endpoint, headers, extra, onDone }: { title: string; help?: string; endpoint: string; headers?: Record<string, string>; extra?: Record<string, unknown>; onDone?: () => void }) {
  const [stars, setStars] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [err, setErr] = useState("");
  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!stars) { setErr("Choose a rating from 1 to 5 stars."); return; }
    setState("busy"); setErr("");
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...(headers ?? {}) }, body: JSON.stringify({ ...(extra ?? {}), stars, feedback }) });
      const d = await res.json().catch(() => ({}));
      if (res.ok || res.status === 409) { setState("done"); onDone?.(); if (!res.ok) setErr(d.error ?? ""); return; }
      setErr(d.error ?? "Could not save your rating."); setState("idle");
    } catch { setErr("Could not reach the server. Try again."); setState("idle"); }
  }
  if (state === "done") return <p className="notice" role="status">{err || "Thank you for your feedback."}</p>;
  return (
    <div className="panel" role="group" aria-label={title} style={{ marginTop: ".75rem" }}>
      <h3>{title}</h3>
      {help && <p className="muted">{help}</p>}
      <div role="radiogroup" aria-label="Star rating" style={{ display: "flex", gap: ".25rem", margin: ".5rem 0" }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={stars === n} aria-label={`${n} star${n > 1 ? "s" : ""}`} onClick={() => setStars(n)} style={{ minWidth: 44, minHeight: 44, fontSize: "1.6rem", background: "none", border: "none", cursor: "pointer", color: n <= stars ? "#c9a24a" : "#777" }}>{n <= stars ? "★" : "☆"}</button>
        ))}
      </div>
      <div className="field"><label htmlFor="rate-fb">Comments (optional)</label><textarea id="rate-fb" maxLength={1000} value={feedback} onChange={(e) => setFeedback(e.target.value)} style={{ minHeight: 80 }} /></div>
      {err && <p className="notice notice--error" role="alert">{err}</p>}
      <p><button type="button" className="btn btn--primary" style={{ minHeight: 48 }} disabled={state === "busy"} onClick={submit}>{state === "busy" ? "Sending…" : "Submit rating"}</button></p>
    </div>
  );
}
