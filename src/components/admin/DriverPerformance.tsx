"use client";

import { useState } from "react";

export interface PerfDriver {
  id: string; name: string; points: number; showRating: boolean; showPoints: boolean;
  ratingAvg: number | null; ratingCount: number;
  history: { at: string; previous: number; next: number; adjustment: number; reason: string | null; admin: string | null }[];
  reviews: { at: string; stars: number; feedback: string | null; reference: string | null }[];
  customerRatings: { at: string; stars: number; feedback: string | null; reference: string | null }[];
}

/**
 * Admin-only. Two separate systems: customer star ratings (read-only here) and admin performance points (adjustable, 0-100, logged).
 * The two show/hide switches only control what the DRIVER sees; administrators always see everything and nothing is ever deleted.
 */
export default function DriverPerformance({ drivers, tz }: { drivers: PerfDriver[]; tz: string }) {
  const [list, setList] = useState(drivers);
  const [msg, setMsg] = useState<{ id: string; kind: "ok" | "error"; text: string } | null>(null);
  const [draft, setDraft] = useState<Record<string, { delta: string; reason: string }>>({});
  const when = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const patch = (id: string, p: Partial<PerfDriver>) => setList((l) => l.map((d) => (d.id === id ? { ...d, ...p } : d)));

  async function adjust(d: PerfDriver) {
    const v = draft[d.id] ?? { delta: "", reason: "" };
    const res = await fetch("/api/admin/drivers/points", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ driverId: d.id, adjustment: v.delta === "" ? undefined : Number(v.delta), reason: v.reason }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setMsg({ id: d.id, kind: "error", text: data.error ?? "Could not update the score." });
    patch(d.id, { points: data.points, history: [{ at: new Date().toISOString(), previous: data.previous, next: data.points, adjustment: data.points - data.previous, reason: v.reason || null, admin: "you" }, ...d.history].slice(0, 8) });
    setDraft((x) => ({ ...x, [d.id]: { delta: "", reason: "" } }));
    setMsg({ id: d.id, kind: "ok", text: `Score changed from ${data.previous} to ${data.points}.` });
  }
  async function visibility(d: PerfDriver, key: "showRating" | "showPoints", value: boolean) {
    const res = await fetch("/api/admin/drivers/visibility", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ driverId: d.id, [key]: value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setMsg({ id: d.id, kind: "error", text: data.error ?? "Could not change visibility." });
    patch(d.id, { showRating: data.showRating, showPoints: data.showPoints });
    setMsg({ id: d.id, kind: "ok", text: "Visibility updated. Stored data is unchanged." });
  }

  return (
    <section aria-label="Driver performance" style={{ margin: "1.5rem 0" }}>
      <h2>Driver performance</h2>
      <p className="adm-sub">Customer star ratings and admin performance points are separate. Points are never calculated from ratings. The switches only decide what each driver sees on their own dashboard; you always see both, and hiding never deletes anything.</p>
      {list.length === 0 && <p className="muted">No drivers yet.</p>}
      {list.map((d) => {
        const v = draft[d.id] ?? { delta: "", reason: "" };
        return (
          <details key={d.id} className="panel" style={{ marginTop: ".6rem" }}>
            <summary style={{ cursor: "pointer", minHeight: 44, display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
              <strong>{d.name}</strong>
              <span>{d.ratingAvg != null ? `★ ${d.ratingAvg.toFixed(1)} (${d.ratingCount})` : "No ratings yet"}</span>
              <span>Points: <strong>{d.points}</strong>/100</span>
            </summary>
            <div style={{ display: "grid", gap: ".75rem", marginTop: ".75rem" }}>
              <fieldset className="fieldset"><legend>What the driver sees</legend>
                <label className="choice"><input type="checkbox" checked={d.showRating} onChange={(e) => visibility(d, "showRating", e.target.checked)} /><span>Show customer star rating to this driver</span></label>
                <label className="choice"><input type="checkbox" checked={d.showPoints} onChange={(e) => visibility(d, "showPoints", e.target.checked)} /><span>Show admin performance points to this driver</span></label>
              </fieldset>
              <fieldset className="fieldset"><legend>Adjust performance points (0 to 100)</legend>
                <div className="form-grid">
                  <div className="field"><label htmlFor={`d-${d.id}`}>Change by (use a minus to subtract)</label><input id={`d-${d.id}`} type="number" step={1} min={-100} max={100} value={v.delta} onChange={(e) => setDraft((x) => ({ ...x, [d.id]: { ...v, delta: e.target.value } }))} placeholder="e.g. 5 or -10" /></div>
                  <div className="field"><label htmlFor={`r-${d.id}`}>Reason (optional)</label><input id={`r-${d.id}`} maxLength={300} value={v.reason} onChange={(e) => setDraft((x) => ({ ...x, [d.id]: { ...v, reason: e.target.value } }))} /></div>
                </div>
                <p><button type="button" className="btn btn--primary" disabled={v.delta === ""} onClick={() => adjust(d)}>Apply change</button></p>
                {msg?.id === d.id && <p className={`notice ${msg.kind === "error" ? "notice--error" : ""}`} role="status">{msg.text}</p>}
              </fieldset>
              <div><h3>Points history</h3>{d.history.length === 0 ? <p className="muted">No adjustments yet.</p> : <ul>{d.history.map((h, i) => <li key={i}>{when(h.at)}: {h.previous} → {h.next} ({h.adjustment > 0 ? "+" : ""}{h.adjustment}){h.reason ? ` · ${h.reason}` : ""}{h.admin ? ` · by ${h.admin}` : ""}</li>)}</ul>}</div>
              <div><h3>Customer reviews of this driver</h3>{d.reviews.length === 0 ? <p className="muted">None yet.</p> : <ul>{d.reviews.map((r, i) => <li key={i}>{when(r.at)}: {"★".repeat(r.stars)}{"☆".repeat(5 - r.stars)}{r.reference ? ` · ${r.reference}` : ""}{r.feedback ? ` · “${r.feedback}”` : ""}</li>)}</ul>}</div>
              <div><h3>This driver&apos;s ratings of customers (internal)</h3>{d.customerRatings.length === 0 ? <p className="muted">None yet.</p> : <ul>{d.customerRatings.map((r, i) => <li key={i}>{when(r.at)}: {"★".repeat(r.stars)}{"☆".repeat(5 - r.stars)}{r.reference ? ` · ${r.reference}` : ""}{r.feedback ? ` · “${r.feedback}”` : ""}</li>)}</ul>}</div>
            </div>
          </details>
        );
      })}
    </section>
  );
}
