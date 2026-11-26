"use client";

import { driverInitials } from "@/lib/driver/profile";
import Link from "next/link";
import { useEffect, useState } from "react";
import ChatPanel from "@/components/chat/ChatPanel";
import StarRatingForm from "@/components/StarRatingForm";
import { formatMoney } from "@/lib/pricing/engine";
import type { TripView } from "@/lib/trip";

export type ClientCredential = { kind: "token"; token: string } | { kind: "code"; code: string };

/** Customer-facing helpline button. The number comes only from the configured Vanta helpline; there is no per-driver or per-customer calling. */
export function HelplineButton({ helpline }: { helpline: TripView["helpline"] }) {
  if (!helpline) return <p className="muted">Need help? Our support phone number is not available online right now. Please use the Contact page.</p>;
  return (
    <p>
      <a className="btn btn--ghost" style={{ minHeight: 48 }} href={`tel:${helpline.tel}`}>Call Vanta Support</a>
      <span className="muted" style={{ display: "block", marginTop: ".4rem" }}>{helpline.display}. Our team can help with your ride or reach your driver for you. Standard telephone charges from your carrier may apply.</span>
    </p>
  );
}

const STATE_TEXT = { done: "completed", current: "current step", upcoming: "not reached yet" } as const;

/** Accessible progress timeline built from real booking facts. Never a fake percentage bar. */
export function Timeline({ steps }: { steps: TripView["steps"] }) {
  return (
    <ol className="tl" aria-label="Ride progress">
      {steps.map((s) => (
        <li key={s.key} className={`tl__step tl__step--${s.state}${s.ended ? " tl__step--ended" : ""}`} aria-current={s.state === "current" ? "step" : undefined}>
          <span className="tl__dot" aria-hidden="true">{s.ended ? "✕" : s.state === "done" ? "✓" : ""}</span>
          <span className="tl__label">{s.label}<span className="sr-only"> ({s.ended ? "ended" : STATE_TEXT[s.state]})</span></span>
        </li>
      ))}
    </ol>
  );
}

export default function TripStatus({ credential, initial, tz }: { credential: ClientCredential; initial: TripView; tz: string }) {
  const [trip, setTrip] = useState(initial);
  const credKey = credential.kind === "token" ? `t:${credential.token}` : `c:${credential.code}`;
  useEffect(() => {
    let stop = false;
    async function poll() {
      if (document.hidden) return;
      try {
        const res = credential.kind === "token"
          ? await fetch(`/api/trip/${credential.token}`, { cache: "no-store" })
          : await fetch("/api/track", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackingId: credential.code }) });
        if (res.ok && !stop) setTrip(((await res.json()) as { trip: TripView }).trip);
      } catch { /* keep the last known status */ }
    }
    const t = setInterval(poll, 6000);
    const onVis = () => { if (!document.hidden) poll(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { stop = true; clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credKey]);

  const c = trip.charges;
  const when = new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(trip.pickupAt));
  const chatEndpoint = credential.kind === "token" ? `/api/trip/${credential.token}/messages` : "/api/track/messages";
  const chatHeaders = credential.kind === "code" ? { "x-tracking-id": credential.code } : undefined;
  return (
    <>
      <p className="lede">Reference <strong>{trip.reference}</strong> · pickup {when}</p>
      <div role="status" aria-live="polite" className={`notice ${trip.ended ? "notice--error" : ""}`}><strong>{trip.headline}</strong>{trip.terminalNote && <p style={{ marginTop: ".25rem" }}>{trip.terminalNote}</p>}</div>
      <Timeline steps={trip.steps} />

      {trip.status === "new_request" || trip.status === "pending_confirmation" ? <p className="muted">Your request is awaiting approval. You have not been charged. We will email you when it is approved.</p> : null}
      {trip.awaitingPayment && <p className="muted">Your booking is approved. It is confirmed once your payment is received and verified. Use the secure payment link in your approval email{credential.kind === "token" ? " or the button below" : ""}.</p>}
      {trip.confirmed && !trip.ended && <p className="muted">Your booking is confirmed and payment was received.</p>}

      {trip.driver && (
        <section className="panel" aria-label="Your driver" style={{ marginTop: "1rem" }}>
          <h3>Your driver</h3>
          <div style={{ display: "flex", gap: ".85rem", alignItems: "center" }}>
            {trip.driver.photoUrl
              ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={trip.driver.photoUrl} alt={`${trip.driver.name}, your driver`} width={64} height={64} style={{ borderRadius: "50%", objectFit: "cover", flex: "none" }} />
                </>
              )
              : <span aria-hidden="true" style={{ width: 64, height: 64, borderRadius: "50%", display: "grid", placeItems: "center", background: "var(--surface-2, #1c1c1c)", fontWeight: 700, flex: "none" }}>{driverInitials(trip.driver.name)}</span>}
            <div>
              <p><strong>{trip.driver.name}</strong></p>
              {trip.driver.vehicle && <p className="muted">{trip.driver.vehicle}</p>}
              {trip.driver.plate && <p className="muted">License plate: <strong>{trip.driver.plate}</strong></p>}
            </div>
          </div>
        </section>
      )}

      <section className="panel" aria-label="Trip details" style={{ marginTop: "1rem" }}>
        <h3>Trip</h3>
        <dl className="kv">
          <dt>Pickup</dt><dd>{trip.pickup}</dd>
          {trip.stops.map((s, i) => [<dt key={`k${i}`}>Stop {i + 1}</dt>, <dd key={`v${i}`}>{s}</dd>])}
          {trip.dropoff && <><dt>Destination</dt><dd>{trip.dropoff}</dd></>}
          {(trip.vehicleCategory || trip.vehicle) && <><dt>Vehicle</dt><dd>{[trip.vehicleCategory, trip.tier].filter(Boolean).join(" · ") || trip.vehicle}</dd></>}
          <dt>Passengers</dt><dd>{trip.passengers}</dd>
        </dl>
        {c && (
          <table className="lines" aria-label="Charges"><tbody>
            <tr><td>Trip fare</td><td>{formatMoney(c.tripFareCents, c.currency)}</td></tr>
            {c.meetGreetCents > 0 && <tr><td>Airport Meet &amp; Greet</td><td>{formatMoney(c.meetGreetCents, c.currency)}</td></tr>}
            {c.childSeatCents > 0 && <tr><td>Child car seats</td><td>{formatMoney(c.childSeatCents, c.currency)}</td></tr>}
            <tr className="total"><td>Total</td><td>{formatMoney(c.totalCents, c.currency)}</td></tr>
          </tbody></table>
        )}
        {credential.kind === "token" && <p className="muted">Payment: {trip.paymentStatus.replace(/_/g, " ")}</p>}
        {trip.payable && credential.kind === "token" && <p><Link className="btn btn--primary" href={`/pay/${credential.token}`}>Pay securely online</Link></p>}
      </section>

      <section className="panel" aria-label="Support" style={{ marginTop: "1rem" }}>
        <h3>Need help?</h3>
        <HelplineButton helpline={trip.helpline} />
      </section>

      {trip.driver && !trip.chatAvailable && !trip.ended && <p className="muted" style={{ marginTop: "1rem" }}>Messaging with your driver opens 24 hours before pickup. For anything urgent, use Call Vanta Support.</p>}
      {trip.rating.canRate && (trip.rating.rated
        ? <p className="muted" style={{ marginTop: "1rem" }}>Thank you. You have rated this ride.</p>
        : <StarRatingForm title="How was your driver?" help="Your rating and comments go to Vanta and help us look after our drivers and customers." endpoint={credential.kind === "token" ? `/api/trip/${credential.token}/rating` : "/api/track/rating"} headers={chatHeaders} />)}
      {trip.chatAvailable && <ChatPanel role="customer" endpoint={chatEndpoint} headers={chatHeaders} title="Message your driver" />}
    </>
  );
}
