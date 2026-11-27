"use client";

import { useEffect, useState } from "react";
import BookingActions from "@/components/BookingActions";
import { Timeline } from "@/components/TripStatus";
import { formatMoney } from "@/lib/pricing/engine";
import { postJson } from "@/lib/customer-client";
import type { TripView } from "@/lib/trip";

/**
 * The customer's booking page body: honest status headline, price, and the action that applies right now (save card / confirm / authenticate).
 * It keeps itself current; a return from Stripe or the bank is verified by the SERVER (nothing in the address bar is trusted).
 */
export default function ConfirmationLive({ token, initial }: { token: string; initial: TripView }) {
  const [trip, setTrip] = useState(initial);
  async function load() {
    try { const r = await fetch(`/api/trip/${token}`, { cache: "no-store" }); if (r.ok) setTrip(((await r.json()) as { trip: TripView }).trip); } catch { /* keep last status */ }
  }
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    (async () => {
      if (q.get("setup_intent")) await postJson("/api/bookings/card/complete", { token }); // returned from a redirect-based card check: the server verifies with Stripe
      else if (q.get("payment_intent")) await postJson("/api/bookings/confirm/finalize", { token }); // returned from the bank's authentication
      if (q.get("setup_intent") || q.get("payment_intent")) { history.replaceState(null, "", `/book/confirmation?t=${encodeURIComponent(token)}`); await load(); }
    })();
    const t = setInterval(() => { if (!document.hidden) void load(); }, 6000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const c = trip.charges;
  return (
    <>
      <div role="status" aria-live="polite" className={`notice ${trip.ended ? "notice--error" : ""}`}><strong>{trip.headline}</strong>{trip.terminalNote && <p style={{ marginTop: ".25rem" }}>{trip.terminalNote}</p>}</div>
      {c && (
        <section className="panel-dark" aria-label="Price" style={{ marginTop: "1rem" }}>
          <table className="lines"><tbody>
            <tr><td>Trip fare</td><td>{formatMoney(c.tripFareCents, c.currency)}</td></tr>
            {c.meetGreetCents > 0 && <tr><td>Airport Meet &amp; Greet</td><td>{formatMoney(c.meetGreetCents, c.currency)}</td></tr>}
            {c.childSeatCents > 0 && <tr><td>Child car seats</td><td>{formatMoney(c.childSeatCents, c.currency)}</td></tr>}
            <tr className="total"><td>Total</td><td>{formatMoney(c.totalCents, c.currency)}</td></tr>
          </tbody></table>
        </section>
      )}
      <BookingActions cred={{ kind: "token", token }} trip={trip} onRefresh={load} />
      {trip.steps.length > 0 && <Timeline steps={trip.steps} />}
    </>
  );
}
