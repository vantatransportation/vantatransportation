"use client";

import { useEffect, useState } from "react";
import { STATUS_LABEL } from "@/lib/booking-status";
import type { DriverProfileCard, DriverRide } from "@/lib/driver/rides";
import { driverInitials } from "@/lib/driver/profile";
import { splitRides } from "@/lib/driver/dashboard";
import ChatPanel from "@/components/chat/ChatPanel";
import StarRatingForm from "@/components/StarRatingForm";

const ACTION_LABEL: Record<string, string> = { getting_ready: "Getting Ready", on_the_way: "Leave for pickup", arrived: "Arrived at pickup", picked_up: "Passenger picked up", completed: "Complete ride" };
const fmt = (iso: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export default function DriverDashboard({ profile: initialProfile, name, plate, initial, tz, helpline, serverNow }: { profile: DriverProfileCard | null; name: string; plate: string | null; initial: DriverRide[]; tz: string; helpline: { display: string; tel: string } | null; serverNow: string }) {
  const [rides, setRides] = useState(initial);
  const [profile, setProfile] = useState(initialProfile);
  // Display only: the offset between the server clock and this device lets buttons unlock on time even if the phone clock is wrong.
  // The server re-checks every time window on each request, so this can never grant access by itself.
  const [offset, setOffset] = useState(() => new Date(serverNow).getTime() - Date.now());
  const [nowMs, setNowMs] = useState(() => new Date(serverNow).getTime());
  useEffect(() => { const t = setInterval(() => setNowMs(Date.now() + offset), 15_000); return () => clearInterval(t); }, [offset]);
  const [busy, setBusy] = useState(""); const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function reload() {
    const res = await fetch("/api/driver/rides", { cache: "no-store" });
    if (res.status === 401) return window.location.assign("/driver/login");
    if (res.ok) {
      const d = (await res.json()) as { rides: DriverRide[]; profile?: DriverProfileCard | null; serverNow?: string };
      setRides(d.rides); if (d.profile !== undefined) setProfile(d.profile);
      if (d.serverNow) setOffset(new Date(d.serverNow).getTime() - Date.now());
    }
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

  const { active, next, later, lastCompleted } = splitRides(rides);
  const card = (r: DriverRide, featured = false) => <RideCard key={r.id} r={r} tz={tz} busy={busy} onAdvance={advance} nowMs={nowMs} featured={featured} />;
  const shown = profile?.displayName ?? name;

  return (
    <>
      <header className="panel" style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }} aria-label="Your profile">
        {profile?.imageUrl
          ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={profile.imageUrl} alt="" width={72} height={72} style={{ borderRadius: "50%", objectFit: "cover", flex: "none" }} />
            </>
          )
          : <span aria-hidden="true" style={{ width: 72, height: 72, borderRadius: "50%", display: "grid", placeItems: "center", background: "var(--surface-2, #1c1c1c)", fontWeight: 700, fontSize: "1.4rem", flex: "none" }}>{driverInitials(shown)}</span>}
        <div style={{ flex: "1 1 14rem", minWidth: 0 }}>
          <h1 style={{ fontSize: "1.5rem" }}>{shown}</h1>
          <p className="muted">{profile?.vehicle ?? "Vehicle not set"}{(profile?.plate ?? plate) ? ` · ${profile?.plate ?? plate}` : ""}</p>
          {(profile?.location || profile?.preferredArea) && <p className="muted">{[profile?.location, profile?.preferredArea && `Preferred area: ${profile.preferredArea}`].filter(Boolean).join(" · ")}</p>}
        </div>
        {(profile?.rating || profile?.points != null) && (
          <dl style={{ display: "flex", gap: "1.25rem", margin: 0 }} aria-label="Your performance">
            {profile?.rating && <div><dt className="muted" style={{ fontSize: ".8rem" }}>Customer rating</dt><dd style={{ fontWeight: 700, fontSize: "1.25rem" }}>{profile.rating.avg != null ? `★ ${profile.rating.avg.toFixed(1)}` : "No ratings yet"}{profile.rating.count > 0 && <span className="muted" style={{ fontSize: ".85rem", fontWeight: 400 }}> ({profile.rating.count})</span>}</dd></div>}
            {profile?.points != null && <div><dt className="muted" style={{ fontSize: ".8rem" }}>Performance points</dt><dd style={{ fontWeight: 700, fontSize: "1.25rem" }}>{profile.points}<span className="muted" style={{ fontSize: ".85rem", fontWeight: 400 }}> / 100</span></dd></div>}
          </dl>
        )}
        <button type="button" className="btn btn--ghost" onClick={signOut}>Sign out</button>
      </header>

      <div role="status" aria-live="polite">{msg && <div className={`notice ${msg.kind === "error" ? "notice--error" : ""}`}>{msg.text}</div>}</div>
      <p style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
        <span className="pill">{active.length} in progress</span><span className="pill">{next ? 1 + later.length : 0} upcoming</span>
        <button type="button" className="linkbtn" onClick={reload}>Refresh</button>
      </p>

      {active.length > 0 && <section aria-label="Rides in progress" style={{ marginTop: "1rem" }}><h2 style={{ fontSize: "1.25rem" }}>In progress</h2>{active.map((r) => card(r, true))}</section>}

      <section aria-label="Next ride" style={{ marginTop: "1.25rem" }}>
        <h2 style={{ fontSize: "1.25rem" }}>Next ride</h2>
        {next ? card(next, active.length === 0) : <p className="muted">No upcoming rides assigned to you.</p>}
      </section>

      {later.length > 0 && <section aria-label="Later rides" style={{ marginTop: "1.25rem" }}><h2 style={{ fontSize: "1.25rem" }}>Later <span className="muted">({later.length})</span></h2>{later.map((r) => card(r))}</section>}

      <section aria-label="Last completed ride" style={{ marginTop: "1.25rem" }}>
        <h2 style={{ fontSize: "1.25rem" }}>Last completed ride</h2>
        {lastCompleted ? <CompletedCard r={lastCompleted} tz={tz} onRated={reload} /> : <p className="muted">Nothing completed yet.</p>}
      </section>

      <section className="panel" style={{ marginTop: "2rem" }} aria-label="Support">
        <h2 style={{ fontSize: "1.1rem" }}>Need help with a ride?</h2>
        <p className="muted">Customer phone numbers are not shared. Message the customer from the ride, or call Vanta support and we will help.</p>
        {helpline ? <p><a className="btn btn--ghost" style={{ minHeight: 48 }} href={`tel:${helpline.tel}`}>Call Vanta Support</a><span className="muted" style={{ display: "block", marginTop: ".4rem" }}>{helpline.display}</span></p> : <p className="muted">The Vanta support number is not configured yet. Ask an administrator.</p>}
      </section>
    </>
  );
}

function CompletedCard({ r, tz, onRated }: { r: DriverRide; tz: string; onRated: () => void }) {
  return (
    <article className="panel" style={{ marginTop: ".5rem" }}>
      <p style={{ display: "flex", justifyContent: "space-between", gap: ".5rem", flexWrap: "wrap" }}><strong>{fmt(r.pickupAt, tz)}</strong><span className="pill">{STATUS_LABEL[r.status]}</span></p>
      <p className="muted">{r.reference} · {r.pickup}{r.dropoff ? ` → ${r.dropoff}` : ""}</p>
      {r.customerRated
        ? <p className="muted">You rated this customer. Thank you.</p>
        : <StarRatingForm title="Rate this customer" help="Private feedback for Vanta staff only. The customer never sees it." endpoint="/api/driver/rate-customer" extra={{ bookingId: r.id }} onDone={onRated} />}
    </article>
  );
}

function RideCard({ r, tz, busy, onAdvance, nowMs, featured }: { r: DriverRide; tz: string; busy: string; onAdvance: (r: DriverRide, s: string) => void; nowMs: number; featured: boolean }) {
  const [chat, setChat] = useState(false);
  const bags = r.checkedBags != null || r.carryOnBags != null ? `${r.checkedBags ?? 0} checked · ${r.carryOnBags ?? 0} carry-on` : null;
  const lockFor = (s: string): { locked: boolean; text: string } => {
    const at = s === "on_the_way" ? r.leaveOpensAt : s === "picked_up" ? r.startOpensAt : null;
    if (s !== "on_the_way" && s !== "picked_up") return { locked: false, text: "" };
    if (!at) return { locked: true, text: "This ride has no valid pickup time." };
    const locked = nowMs < new Date(at).getTime();
    return { locked, text: locked ? (s === "picked_up" ? `You can start this ride from ${fmt(at, tz)} (two hours before pickup).` : `You can leave for this pickup from ${fmt(at, tz)}.`) : "" };
  };
  return (
    <article className="panel" style={{ marginTop: ".75rem", ...(featured ? { borderLeft: "4px solid var(--accent, #c9a24a)" } : {}) }}>
      <p style={{ display: "flex", justifyContent: "space-between", gap: ".5rem", flexWrap: "wrap", fontSize: featured ? "1.15rem" : undefined }}><strong>{fmt(r.pickupAt, tz)}</strong><span className="pill">{STATUS_LABEL[r.status]}</span></p>
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
      {r.open && r.chatOpen && <p><button type="button" className="btn btn--ghost" style={{ minHeight: 48, width: "100%" }} aria-expanded={chat} onClick={() => setChat((v) => !v)}>{chat ? "Hide chat" : "Chat with customer"}</button></p>}
      {r.open && !r.chatOpen && <p className="muted">{r.awaitingPayment ? "Chat opens once the booking is confirmed." : r.chatOpensAt ? `Chat with the customer opens ${fmt(r.chatOpensAt, tz)} (24 hours before pickup).` : "Chat is not available for this ride."}</p>}
      {chat && r.open && r.chatOpen && <ChatPanel role="driver" endpoint="/api/driver/messages" bookingId={r.id} title="Chat with customer" />}
      {r.awaitingPayment && <p className="notice" role="status">Waiting for payment to be confirmed. The ride cannot start until it is.</p>}
      {(r.status === "assigned" || r.status === "confirmed") && !r.awaitingPayment && <p className="muted" style={{ marginTop: ".75rem" }}>Tap Getting Ready to confirm you have seen this ride and are responsible for it.</p>}
      {r.nextStatuses.length > 0 && (
        <div style={{ display: "grid", gap: ".5rem", marginTop: ".75rem" }}>
          {r.nextStatuses.map((s, i) => {
            const { locked, text } = lockFor(s);
            return (
              <div key={s}>
                <button type="button" className={`btn ${i === r.nextStatuses.length - 1 ? "btn--primary" : "btn--ghost"}`} style={{ minHeight: 52, width: "100%" }} disabled={!!busy || locked} aria-describedby={locked ? `lock-${r.id}-${s}` : undefined} onClick={() => onAdvance(r, s)}>{busy === r.id + s ? "Updating…" : ACTION_LABEL[s]}</button>
                {locked && <p id={`lock-${r.id}-${s}`} className="muted" style={{ marginTop: ".3rem" }}>{text}</p>}
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}
