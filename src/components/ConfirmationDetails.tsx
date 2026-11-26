"use client";

import Link from "next/link";
import { useMemo } from "react";
import { formatMoney } from "@/lib/pricing/engine";
import { useSessionString } from "@/lib/use-session";
import { trackingPath } from "@/lib/tracking-url";

/** Server-confirmed, customer-safe pricing from POST /api/bookings: ONE combined trip fare, services separately, total. */
interface SavedPricing { tripFareCents: number; meetGreetCents: number; childSeatCents: number; totalCents: number }
interface Saved { reference: string; pricing?: SavedPricing | null; currency: string; shownTotalCents: number | null; trackingId?: string | null }

export default function ConfirmationDetails({ reference }: { reference: string }) {
  const raw = useSessionString("vanta:confirmation");
  const saved = useMemo<Saved | null>(() => {
    try {
      const s = raw ? (JSON.parse(raw) as Saved) : null;
      return s && s.reference === reference ? s : null;
    } catch {
      return null;
    }
  }, [raw, reference]);
  if (!saved) return null;
  // The saved amounts are what the server calculated; compare the total with what the customer saw.
  const p = saved.pricing ?? null;
  const changed = p != null && saved.shownTotalCents != null && p.totalCents !== saved.shownTotalCents;
  return (
    <div className="notice" style={{ marginTop: "1.5rem" }}>
      {p ? (
        <table className="lines" aria-label="Price"><tbody>
          <tr><td>Trip fare</td><td>{formatMoney(p.tripFareCents, saved.currency)}</td></tr>
          {p.meetGreetCents > 0 && <tr><td>Airport Meet &amp; Greet</td><td>{formatMoney(p.meetGreetCents, saved.currency)}</td></tr>}
          {p.childSeatCents > 0 && <tr><td>Child car seats</td><td>{formatMoney(p.childSeatCents, saved.currency)}</td></tr>}
          <tr className="total"><td>Total</td><td>{formatMoney(p.totalCents, saved.currency)}</td></tr>
        </tbody></table>
      ) : <p>We will confirm your price with you.</p>}
      {changed && <p className="muted" style={{ marginTop: ".5rem" }}>The total differs from the one you saw ({formatMoney(saved.shownTotalCents!, saved.currency)}) because our prices were updated. The amount shown here is the one we recorded.</p>}
      {saved.trackingId && (
        <div style={{ marginTop: "1rem" }}>
          <p>Your tracking ID: {trackingPath(saved.trackingId) ? <Link href={trackingPath(saved.trackingId)!} style={{ textDecoration: "underline", fontWeight: 700, letterSpacing: ".05em" }}>{saved.trackingId}</Link> : <strong style={{ letterSpacing: ".05em" }}>{saved.trackingId}</strong>}</p>
          <p className="muted" style={{ marginTop: ".4rem" }}>Keep it private. It is also in your email. Select it, or use <Link href="/track" style={{ textDecoration: "underline" }}>Track Your Ride</Link>, to follow your request. No payment is taken now: if we approve your booking we email you a secure payment link, and it is confirmed once that payment is verified.</p>
        </div>
      )}
    </div>
  );
}
