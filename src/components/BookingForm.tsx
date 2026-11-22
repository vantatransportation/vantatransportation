"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useSessionString } from "@/lib/use-session";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/pricing/engine";
import { openCalculator } from "@/lib/calculator-events";
import { looksLikeAirport } from "@/lib/coverage";
import { TRIP_STORAGE_KEY, type StoredTrip } from "@/lib/fare/client-types";
import type { PublicPolicies } from "@/lib/policies";
import { SEAT_CONFIRMATION_NOTE } from "@/lib/policy-text";
import { seatCount } from "@/lib/child-seats";

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "error"; message: string; fields?: Record<string, string> };

export default function BookingForm({ policies }: { policies: PublicPolicies }) {
  const router = useRouter();
  const raw = useSessionString(TRIP_STORAGE_KEY);
  const stored = useMemo<StoredTrip | null | undefined>(() => {
    if (raw === undefined) return undefined;
    try {
      return raw ? (JSON.parse(raw) as StoredTrip) : null;
    } catch {
      return null;
    }
  }, [raw]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [bookingFor, setBookingFor] = useState<"self" | "other">("self");
  const [airportOn, setAirportOn] = useState<boolean | null>(null); // null = follow the auto-detected default
  const [secondContact, setSecondContact] = useState(false);

  if (stored === undefined) return <p className="muted">Loading your trip…</p>;
  if (!stored) {
    return (
      <div className="notice">
        <p>We do not have a trip to book yet. Enter your trip first and your details will carry over here.</p>
        <p style={{ marginTop: "1rem", display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
          <button className="btn btn--primary" onClick={() => openCalculator()}>BOOK A RIDE</button>
          <Link className="btn btn--ghost" href="/quote">GET A QUOTE</Link>
        </p>
      </div>
    );
  }

  const { trip, display } = stored;
  const q = display.quote;
  const when = `${trip.date} at ${trip.time}`;
  const detectedAirport = looksLikeAirport(trip.pickup.text) || looksLikeAirport(trip.dropoff.text) || (trip.returnLeg ? looksLikeAirport(trip.returnLeg.pickup.text) || looksLikeAirport(trip.returnLeg.dropoff.text) : false);
  const meetGreet = trip.meetGreet === true; // chosen in Calculate Your Fare; the fee is the selected tier's fee
  const airport = meetGreet ? true : (airportOn ?? detectedAirport);
  const pickupIsAirport = looksLikeAirport(trip.pickup.text);
  const airportGuess = pickupIsAirport ? trip.pickup.text : looksLikeAirport(trip.dropoff.text) ? trip.dropoff.text : "";
  const online = display.online ?? null;
  const onlineTotal = online && online.fixedPriceCents != null ? online.fixedPriceCents + online.meetGreetCents + online.seatFeeCents : null;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status.kind === "sending" || !stored) return;
    const fd = new FormData(e.currentTarget);
    const g = (k: string) => String(fd.get(k) ?? "");
    const contacts = [0, 1].map((i) => ({ name: g(`c${i}.name`), relationship: g(`c${i}.relationship`), phone: g(`c${i}.phone`), type: g(`c${i}.type`) || (i === 0 ? "emergency" : "secondary") }));
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/bookings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trip: stored.trip, vehicleId: stored.vehicleId, tierId: stored.tierId, routeKey: stored.routeKey, submissionKey: stored.submissionKey,
          name: g("name"), email: g("email"), phone: g("phone"), notes: g("notes"), website: g("website"),
          bookingFor, passenger: bookingFor === "other" ? { name: g("p.name"), phone: g("p.phone"), email: g("p.email") } : null,
          luggageCount: g("luggage"), assistanceNotes: g("assistance"), pickupInstructions: g("pickupInstructions"), contacts,
          airport: airport ? { airport: g("a.airport"), airline: g("a.airline"), flightNumber: g("a.flightNumber"), direction: g("a.direction"), flightDate: g("a.flightDate"), flightTime: g("a.flightTime"), terminal: g("a.terminal"), passengerName: g("a.passengerName"), pickupInstructions: g("a.instructions"), meetGreet } : null,
          policiesAcknowledged: fd.get("ack") === "on",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setStatus({ kind: "error", message: data.error ?? "Something went wrong. Please try again.", fields: data.fields });
      try {
        sessionStorage.removeItem(TRIP_STORAGE_KEY);
        sessionStorage.setItem("vanta:confirmation", JSON.stringify({ reference: data.reference, totalCents: data.totalCents, currency: data.currency, shownTotalCents: onlineTotal, trackingId: data.trackingId ?? null }));
      } catch { /* ignore */ }
      router.push(`/book/confirmation?ref=${encodeURIComponent(data.reference)}`);
    } catch {
      setStatus({ kind: "error", message: "Could not reach the server. Your details are kept; please try again." });
    }
  }

  const err = status.kind === "error" ? status.fields ?? {} : {};
  const fe = (n: string) => (err[n] ? <span className="field__error" role="alert">{err[n]}</span> : null);

  return (
    <div className="book">
      <section className="panel-dark" aria-label="Your trip">
        <h2>Your trip</h2>
        <dl className="kv-dark">
          <dt>Vehicle</dt><dd>{stored.vehicleName}</dd>
          <dt>{trip.returnLeg ? "Outbound pickup" : "Pickup"}</dt><dd>{trip.pickup.text}</dd>
          {trip.stops.map((s, i) => [<dt key={`k${i}`}>Stop {i + 1}</dt>, <dd key={`v${i}`}>{s.text}</dd>])}
          <dt>Destination</dt><dd>{trip.dropoff.text}</dd>
          <dt>When</dt><dd>{when}</dd>
          {trip.returnLeg && <><dt>Return</dt><dd>{trip.returnLeg.pickup.text} to {trip.returnLeg.dropoff.text}, {trip.returnLeg.date} at {trip.returnLeg.time}</dd></>}
          <dt>Passengers</dt><dd>{trip.passengers}</dd>
          <dt>Trip type</dt><dd>{trip.tripType === "hourly" ? `By the hour (${trip.hours} h)` : trip.returnLeg ? "Round trip" : "Point to point"}</dd>
          <dt>Route</dt><dd>{display.distanceMiles} mi, about {display.durationMinutes} min ({display.routeLabel})</dd>
        </dl>
        <h3 className="summary__h">Charged online</h3>
        {online && online.fixedPriceCents != null ? (
          <table className="lines" aria-label="Amount charged online"><tbody>
            <tr><td>Fixed {online.tierName} price</td><td>{formatMoney(online.fixedPriceCents)}</td></tr>
            {meetGreet && <tr><td>Airport Meet &amp; Greet<span className="tag">requested</span></td><td>{formatMoney(online.meetGreetCents)}</td></tr>}
            {online.seatFeeCents > 0 && <tr><td>Child car seats<span className="tag">requested</span></td><td>{formatMoney(online.seatFeeCents)}</td></tr>}
            <tr className="total"><td>Total due online</td><td>{formatMoney(onlineTotal ?? 0)}</td></tr>
          </tbody></table>
        ) : <p className="muted">An online amount is not set up for this vehicle&apos;s tier yet. We will confirm the price with you.</p>}
        <h3 className="summary__h">Estimated trip fare</h3>
        {q ? (
          <>
            <table className="lines"><tbody><tr className="total"><td>Estimated trip fare</td><td>{formatMoney(q.totalCents, q.currency)}</td></tr></tbody></table>
            <p className="muted">Calculated from distance, time and tolls. For information only: it is not part of the online amount.</p>
            <details><summary>How the estimate is calculated</summary>
              <table className="lines"><tbody>{q.lineItems.map((l, i) => <tr key={i}><td>{l.label}{l.detail && <small className="muted"><br />{l.detail}</small>}</td><td>{l.cents < 0 ? "−" : ""}{formatMoney(Math.abs(l.cents), q.currency)}</td></tr>)}</tbody></table>
            </details>
          </>
        ) : <p className="muted">An estimate is not available. We will confirm the price with you.</p>}
        {meetGreet && <p className="muted">Meet &amp; Greet is requested here and is not confirmed until Vanta confirms it.</p>}
        {trip.childSeats && seatCount(trip.childSeats) > 0 && <p className="muted">{SEAT_CONFIRMATION_NOTE}</p>}
        <p className="muted">We verify the amounts again when you submit. This is a booking request, not a confirmed booking. Nothing is charged when you submit. If we approve your request we email you a secure payment link, and your booking is confirmed once the payment is received.</p>
        <p><button type="button" className="linkbtn" onClick={() => openCalculator({ pickup: trip.pickup.text, dropoff: trip.dropoff.text, date: trip.date, time: trip.time })}>Change trip details</button></p>
      </section>

      <form onSubmit={submit} noValidate className="form-grid" aria-label="Booking details">
        <h2 className="full">Who is booking</h2>
        <div className="field"><label htmlFor="b-name">Your full name</label><input id="b-name" name="name" autoComplete="name" required aria-invalid={!!err.name} />{fe("name")}</div>
        <div className="field"><label htmlFor="b-email">Your email</label><input id="b-email" name="email" type="email" autoComplete="email" required aria-invalid={!!err.email} />{fe("email")}</div>
        <div className="field"><label htmlFor="b-phone">Your phone</label><input id="b-phone" name="phone" type="tel" autoComplete="tel" required aria-invalid={!!err.phone} />{fe("phone")}</div>

        <fieldset className="fieldset">
          <legend>Who is travelling?</legend>
          <div className="choices">
            <label className="choice"><input type="radio" name="bookingFor" checked={bookingFor === "self"} onChange={() => setBookingFor("self")} /><span>Myself</span></label>
            <label className="choice"><input type="radio" name="bookingFor" checked={bookingFor === "other"} onChange={() => setBookingFor("other")} /><span>Someone else (a relative or friend). You are the booker; they are the passenger.</span></label>
          </div>
          {bookingFor === "other" && (
            <div className="form-grid" style={{ marginTop: ".75rem" }}>
              <div className="field"><label htmlFor="p-name">Passenger&apos;s full name</label><input id="p-name" name="p.name" autoComplete="off" required aria-invalid={!!err["passenger.name"]} />{fe("passenger.name")}</div>
              <div className="field"><label htmlFor="p-phone">Passenger&apos;s phone</label><input id="p-phone" name="p.phone" type="tel" autoComplete="off" required aria-invalid={!!err["passenger.phone"]} />{fe("passenger.phone")}</div>
              <div className="field full"><label htmlFor="p-email">Passenger&apos;s email (optional)</label><input id="p-email" name="p.email" type="email" autoComplete="off" />{fe("passenger.email")}</div>
            </div>
          )}
          <div className="form-grid" style={{ marginTop: ".75rem" }}>
            <div className="field"><label htmlFor="b-lug">Bags / luggage (optional)</label><input id="b-lug" name="luggage" type="number" min={0} max={50} />{fe("luggageCount")}</div>
            <div className="field full"><label htmlFor="b-assist">Assistance notes (optional)</label><textarea id="b-assist" name="assistance" style={{ minHeight: 90 }} /><span className="help muted">For example: help with bags or stairs. {policies.assistanceText}</span></div>
            <div className="field full"><label htmlFor="b-pi">Pickup instructions (optional)</label><textarea id="b-pi" name="pickupInstructions" style={{ minHeight: 90 }} placeholder="Door number, building entrance, gate code…" /></div>
          </div>
        </fieldset>

        <fieldset className="fieldset">
          <legend>Airport</legend>
          <label className="choice"><input type="checkbox" checked={airport} disabled={meetGreet} onChange={(e) => setAirportOn(e.target.checked)} /><span>This trip includes an airport pickup or drop-off{meetGreet ? " (required for Airport Meet & Greet)" : ""}</span></label>
          {airport && (
            <div className="form-grid" style={{ marginTop: ".75rem" }}>
              <div className="field"><label htmlFor="a-airport">Airport</label><input id="a-airport" name="a.airport" defaultValue={airportGuess} required aria-invalid={!!err["airport.airport"]} />{fe("airport.airport")}</div>
              <div className="field"><label htmlFor="a-dir">Arrival or departure</label><select id="a-dir" name="a.direction" defaultValue={pickupIsAirport ? "arrival" : "departure"}><option value="arrival">Arrival (pickup at the airport)</option><option value="departure">Departure (drop-off at the airport)</option></select></div>
              <div className="field"><label htmlFor="a-airline">Airline</label><input id="a-airline" name="a.airline" /></div>
              <div className="field"><label htmlFor="a-flight">Flight number</label><input id="a-flight" name="a.flightNumber" /></div>
              <div className="field"><label htmlFor="a-fdate">Flight date</label><input id="a-fdate" name="a.flightDate" type="date" defaultValue={trip.date} />{fe("airport.flightDate")}</div>
              <div className="field"><label htmlFor="a-ftime">Flight time</label><input id="a-ftime" name="a.flightTime" type="time" />{fe("airport.flightTime")}</div>
              <div className="field"><label htmlFor="a-term">Terminal (if known)</label><input id="a-term" name="a.terminal" /></div>
              <div className="field"><label htmlFor="a-pname">Passenger name for the driver</label><input id="a-pname" name="a.passengerName" /></div>
              <div className="field full"><label htmlFor="a-inst">Airport pickup instructions (optional)</label><textarea id="a-inst" name="a.instructions" style={{ minHeight: 80 }} /></div>
            </div>
          )}
        </fieldset>

        <fieldset className="fieldset">
          <legend>Emergency or secondary contact (optional)</legend>
          <p className="muted" style={{ marginBottom: ".75rem" }}>Someone we can reach about this trip if needed. Shared only with authorized staff and the assigned driver or partner when necessary. Never used for promotions. This is not emergency monitoring or live tracking.</p>
          {[0, ...(secondContact ? [1] : [])].map((i) => (
            <div className="form-grid" key={i} style={{ marginBottom: ".75rem" }}>
              <div className="field"><label htmlFor={`c${i}-name`}>Contact name</label><input id={`c${i}-name`} name={`c${i}.name`} autoComplete="off" aria-invalid={!!err[`contacts.${i}.name`]} />{fe(`contacts.${i}.name`)}</div>
              <div className="field"><label htmlFor={`c${i}-phone`}>Contact phone</label><input id={`c${i}-phone`} name={`c${i}.phone`} type="tel" autoComplete="off" aria-invalid={!!err[`contacts.${i}.phone`]} />{fe(`contacts.${i}.phone`)}</div>
              <div className="field"><label htmlFor={`c${i}-rel`}>Relationship (optional)</label><input id={`c${i}-rel`} name={`c${i}.relationship`} autoComplete="off" /></div>
              <div className="field"><label htmlFor={`c${i}-type`}>Contact type</label><select id={`c${i}-type`} name={`c${i}.type`} defaultValue={i === 0 ? "emergency" : "secondary"}><option value="emergency">Emergency contact</option><option value="secondary">Secondary contact</option></select></div>
            </div>
          ))}
          {!secondContact && <button type="button" className="linkbtn" onClick={() => setSecondContact(true)}>+ Add a second contact</button>}
        </fieldset>

        <div className="field full"><label htmlFor="b-notes">Other notes or special requests (optional)</label><textarea id="b-notes" name="notes" /></div>

        <div className="policy-box" role="region" aria-label="Policies">
          <p><strong>Waiting time.</strong> {policies.waitingText}</p>
          <p><strong>No-shows.</strong> {policies.noShowText}</p>
          <p><strong>Availability.</strong> {policies.availabilityText}</p>
        </div>
        <div className="full">
          <label className="choice"><input type="checkbox" name="ack" aria-invalid={!!err.policiesAcknowledged} /><span>I have read the waiting-time and no-show policies.</span></label>
          {fe("policiesAcknowledged")}
        </div>

        <div className="hp" aria-hidden="true"><label htmlFor="b-web">Leave empty</label><input id="b-web" name="website" tabIndex={-1} autoComplete="off" /></div>
        <div className="full">
          <button className="btn btn--primary" type="submit" disabled={status.kind === "sending"}>{status.kind === "sending" ? "Sending request…" : "Send booking request"}</button>
          <div role="alert" aria-live="polite">{status.kind === "error" && <div className="notice notice--error">{status.message}</div>}</div>
          <p className="muted" style={{ marginTop: "1rem" }}>Prefer to talk first? <Link href="/contact" style={{ textDecoration: "underline" }}>Contact us</Link> or <Link href="/quote" style={{ textDecoration: "underline" }}>get a quote</Link>.</p>
        </div>
      </form>
    </div>
  );
}
