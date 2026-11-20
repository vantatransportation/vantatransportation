"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ChatPanel from "@/components/chat/ChatPanel";
import { formatMoney } from "@/lib/pricing/engine";
import type { TripView } from "@/lib/trip";

const STEPS = [["new_request", "Awaiting review"], ["assigned", "Approved, driver assigned"], ["on_the_way", "Driver on the way"], ["arrived", "Driver arrived"], ["picked_up", "Passenger picked up"], ["completed", "Completed"]] as const;
const RANK: Record<string, number> = { new_request: 0, pending_confirmation: 0, confirmed: 1, assigned: 1, getting_ready: 1, on_the_way: 2, arrived: 3, picked_up: 4, in_progress: 4, completed: 5 };
const telHref = (p: string) => `tel:${p.replace(/[^\d+]/g, "")}`;

export default function TripStatus({ token, initial, tz }: { token: string; initial: TripView; tz: string }) {
  const [trip, setTrip] = useState(initial);
  useEffect(() => {
    let stop = false;
    async function poll() {
      if (document.hidden) return;
      try {
        const res = await fetch(`/api/trip/${token}`, { cache: "no-store" });
        if (res.ok && !stop) setTrip(((await res.json()) as { trip: TripView }).trip);
      } catch { /* keep the last known status */ }
    }
    const t = setInterval(poll, 6000);
    const onVis = () => { if (!document.hidden) poll(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { stop = true; clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [token]);

  const ended = ["cancelled", "rejected", "no_show"].includes(trip.status);
  const rank = RANK[trip.status] ?? 0;
  const c = trip.charges;
  const when = new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(trip.pickupAt));
  return (
    <>
      <p className="lede">Reference <strong>{trip.reference}</strong> · pickup {when}</p>
      <div role="status" aria-live="polite" className={`notice ${ended ? "notice--error" : ""}`}><strong>{trip.statusLabel}</strong>{trip.terminalNote && <p style={{ marginTop: ".25rem" }}>{trip.terminalNote}</p>}</div>

      {!ended && (
        <ol aria-label="Progress" style={{ listStyle: "none", padding: 0, margin: "1rem 0", display: "grid", gap: ".35rem" }}>
          {STEPS.map(([key, label], i) => <li key={key} aria-current={i === rank ? "step" : undefined} style={{ opacity: i <= rank ? 1 : 0.45 }}>{i < rank ? "✓" : i === rank ? "●" : "○"} {label}</li>)}
        </ol>
      )}
      {trip.status === "new_request" || trip.status === "pending_confirmation" ? <p className="muted">Your request is awaiting review. You have not been charged, and no driver is confirmed yet. We will email you when it is approved.</p> : null}

      {trip.driver && (
        <section className="panel" aria-label="Your driver" style={{ marginTop: "1rem" }}>
          <h3>Your driver</h3>
          <p><strong>{trip.driver.name}</strong>{trip.driver.vehicle ? ` · ${trip.driver.vehicle}` : ""}{trip.driver.plate ? ` · ${trip.driver.plate}` : ""}</p>
          {trip.driver.phone && <p><a className="btn btn--ghost" style={{ minHeight: 48 }} href={telHref(trip.driver.phone)}>Call driver</a><span className="muted" style={{ display: "block", marginTop: ".4rem" }}>Opens your phone&apos;s dialer. Standard telephone charges from your carrier may apply.</span></p>}
        </section>
      )}

      <section className="panel" aria-label="Trip details" style={{ marginTop: "1rem" }}>
        <h3>Trip</h3>
        <dl className="kv">
          <dt>Pickup</dt><dd>{trip.pickup}</dd>
          {trip.stops.map((s, i) => [<dt key={`k${i}`}>Stop {i + 1}</dt>, <dd key={`v${i}`}>{s}</dd>])}
          {trip.dropoff && <><dt>Destination</dt><dd>{trip.dropoff}</dd></>}
          <dt>Passengers</dt><dd>{trip.passengers}</dd>
          {(trip.checkedBags != null || trip.carryOnBags != null) && <><dt>Luggage</dt><dd>{trip.checkedBags ?? 0} checked, {trip.carryOnBags ?? 0} carry-on</dd></>}
        </dl>
        {c && (
          <table className="lines" aria-label="Charges"><tbody>
            <tr><td>Fixed price</td><td>{formatMoney(c.fixedPriceCents, c.currency)}</td></tr>
            {c.rushCents > 0 && <tr><td>Rush-hour surcharge</td><td>{formatMoney(c.rushCents, c.currency)}</td></tr>}
            {c.tipCents > 0 && <tr><td>Tip</td><td>{formatMoney(c.tipCents, c.currency)}</td></tr>}
            {c.meetGreetCents > 0 && <tr><td>Airport Meet &amp; Greet</td><td>{formatMoney(c.meetGreetCents, c.currency)}</td></tr>}
            {c.seatCents > 0 && <tr><td>Child car seats</td><td>{formatMoney(c.seatCents, c.currency)}</td></tr>}
            <tr className="total"><td>Total online</td><td>{formatMoney(c.totalCents, c.currency)}</td></tr>
          </tbody></table>
        )}
        <p className="muted">Payment: {trip.paymentStatus.replace(/_/g, " ")}</p>
        {trip.payable && <p><Link className="btn btn--primary" href={`/pay/${token}`}>Pay securely online</Link></p>}
      </section>

      {trip.chatAvailable && <ChatPanel role="customer" endpoint={`/api/trip/${token}/messages`} title="Chat with your driver" />}
    </>
  );
}
