"use client";

import { useState } from "react";
import { STATUS_LABEL } from "@/lib/booking-status";
import type { DriverRide } from "@/lib/driver/rides";
import ChatPanel from "@/components/chat/ChatPanel";

const ACTION_LABEL: Record<string, string> = { getting_ready: "Getting ready", on_the_way: "On the way", arrived: "Arrived at pickup", picked_up: "Passenger picked up", completed: "Complete ride" };
const fmt = (iso: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export default function DriverDashboard({ name, plate, initial, tz, helpline }: { name: string; plate: string | null; initial: DriverRide[]; tz: string; helpline: { display: string; tel: string } | null }) {
  const [rides, setRides] = useState(initial);
  const [busy, setBusy] = useState(""); const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function reload() {
    const res = await fetch("/api/driver/rides", { cache: "no-store" });
    if (res.status === 401) return window.location.assign("/driver/login");
    if (res.ok) setRides(((await res.json()) as { rides: DriverRide[] }).rides);
  }
  async function advance(r: DriverRide, status: string) {
    if (busy) return;
    if ((status === "completed" || status === "picked_up") && !window.confirm(`${ACTION_LABEL[status]} for ${r.reference}?`)) return;
    setBusy(r.id + status); setMsg(null);
    try {
      const res = await fetch("/api/driver/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id, status }) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return window.location.assign("/driver/login");
      setMsg(res.ok ? { kind: "ok", text: `${r.reference}: ${STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status}` } : { kind: "error", text: data.error ?? "Could not update." });
      await reload();
    } catch { setMsg({ kind: "error", text: "Could not reach the server. Check your connection and try again." }); }
    setBusy("");
  }
  async function signOut() { await fetch("/api/driver/logout", { method: "POST" }); window.location.assign("/driver/login"); }

  const active = rides.filter((r) => ["getting_ready", "on_the_way", "arrived", "picked_up", "in_progress"].includes(r.status));
  const upcoming = rides.filter((r) => ["assigned", "confirmed"].includes(r.status));
  const past = rides.filter((r) => !r.open).sort((a, b) => b.pickupAt.localeCompare(a.pickupAt)).slice(0, 20);
  const section = (title: string, list: DriverRide[], empty: string) => (
    <section aria-label={title} style={{ marginTop: "1.5rem" }}>
      <h2 style={{ fontSize: "1.25rem" }}>{title} <span className="muted">({list.length})</span></h2>
      {list.length === 0 ? <p className="muted">{empty}</p> : list.map((r) => <RideCard key={r.id} r={r} tz={tz} busy={busy} onAdvance={advance} />)}
    </section>
  );
  return (
    <>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: ".5rem" }}>
        <div><h1 style={{ fontSize: "1.6rem" }}>My rides</h1><p className="muted">{name}{plate ? ` · ${plate}` : ""}</p></div>
        <button type="button" className="btn btn--ghost" onClick={signOut}>Sign out</button>
      </header>
      <div role="status" aria-live="polite">{msg && <div className={`notice ${msg.kind === "error" ? "notice--error" : ""}`}>{msg.text}</div>}</div>
      <p><button type="button" className="linkbtn" onClick={reload}>Refresh</button></p>
      {section("In progress", active, "No ride in progress.")}
      {section("Upcoming", upcoming, "No upcoming rides assigned to you.")}
      {section("Recent", past, "Nothing yet.")}
      <section className="panel" style={{ marginTop: "2rem" }} aria-label="Support">
        <h2 style={{ fontSize: "1.1rem" }}>Need help with a ride?</h2>
        <p className="muted">Customer phone numbers are not shared. Message the customer from the ride, or call Vanta support and we will help.</p>
        {helpline ? <p><a className="btn btn--ghost" style={{ minHeight: 48 }} href={`tel:${helpline.tel}`}>Call Vanta Support</a><span className="muted" style={{ display: "block", marginTop: ".4rem" }}>{helpline.display}</span></p> : <p className="muted">The Vanta support number is not configured yet. Ask an administrator.</p>}
      </section>
    </>
  );
}

function RideCard({ r, tz, busy, onAdvance }: { r: DriverRide; tz: string; busy: string; onAdvance: (r: DriverRide, s: string) => void }) {
  const [chat, setChat] = useState(false);
  const bags = r.checkedBags != null || r.carryOnBags != null ? `${r.checkedBags ?? 0} checked · ${r.carryOnBags ?? 0} carry-on` : null;
  return (
    <article className="panel" style={{ marginTop: ".75rem" }}>
      <p style={{ display: "flex", justifyContent: "space-between", gap: ".5rem", flexWrap: "wrap" }}><strong>{fmt(r.pickupAt, tz)}</strong><span className="pill">{STATUS_LABEL[r.status]}</span></p>
      <p className="muted">{r.reference}</p>
      <dl className="kv" style={{ marginTop: ".5rem" }}>
        <dt>Pickup</dt><dd>{r.pickup}</dd>
        {r.stops.map((s, i) => [<dt key={`k${i}`}>Stop {i + 1}</dt>, <dd key={`v${i}`}>{s}</dd>])}
        {r.dropoff && <><dt>Destination</dt><dd>{r.dropoff}</dd></>}
        <dt>Passengers</dt><dd>{r.passengers}</dd>
        {bags && <><dt>Luggage</dt><dd>{bags}</dd></>}
        {r.contactName && <><dt>Customer</dt><dd>{r.contactName}</dd></>}
        {r.passengerName && <><dt>Passenger</dt><dd>{r.passengerName}</dd></>}
        {r.pickupInstructions && <><dt>Pickup notes</dt><dd>{r.pickupInstructions}</dd></>}
        {r.assistanceNotes && <><dt>Assistance</dt><dd>{r.assistanceNotes}</dd></>}
        {r.notes && <><dt>Customer notes</dt><dd>{r.notes}</dd></>}
      </dl>
      {r.open && <p><button type="button" className="btn btn--ghost" style={{ minHeight: 48, width: "100%" }} aria-expanded={chat} onClick={() => setChat((v) => !v)}>{chat ? "Hide chat" : "Chat with customer"}</button></p>}
      {chat && r.open && <ChatPanel role="driver" endpoint="/api/driver/messages" bookingId={r.id} title="Chat with customer" />}
      {r.awaitingPayment && <p className="notice" role="status">Waiting for the customer's payment to be confirmed. You can message the customer, but the ride cannot start until payment is confirmed.</p>}
      {r.nextStatuses.length > 0 && (
        <div style={{ display: "grid", gap: ".5rem", marginTop: ".75rem" }}>
          {r.nextStatuses.map((s, i) => <button key={s} type="button" className={`btn ${i === r.nextStatuses.length - 1 ? "btn--primary" : "btn--ghost"}`} style={{ minHeight: 52, width: "100%" }} disabled={!!busy} onClick={() => onAdvance(r, s)}>{busy === r.id + s ? "Updating…" : ACTION_LABEL[s]}</button>)}
        </div>
      )}
    </article>
  );
}
