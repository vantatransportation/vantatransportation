"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import PlaceInput from "./PlaceInput";
import RouteMap from "./RouteMap";
import VehiclePhoto from "./VehiclePhoto";
import { BETTER_QUOTE_DISCLAIMER, BETTER_QUOTE_REMINDER, SEAT_CONFIRMATION_NOTE } from "@/lib/policy-text";
import { SEAT_LABEL, SEAT_TYPES, type ChildSeats, type SeatType } from "@/lib/child-seats";
import { formatMoney } from "@/lib/pricing/engine";
import { newKey } from "@/lib/uuid";
import type { CalculatorPrefill } from "@/lib/calculator-events";
import { TRIP_STORAGE_KEY, type FareResponse, type PlaceValue, type RouteKey, type StoredTrip, type TripPayload, type VehicleOptionDto } from "@/lib/fare/client-types";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"])';
const empty: PlaceValue = { text: "" };
const tollText = (s: string, amount: number | null) =>
  s === "none" ? "No tolls expected" : s === "avoided" ? "Avoids tolls" : s === "known" ? `Estimated tolls ${formatMoney(Math.round((amount ?? 0) * 100))} included` : "Tolls may apply; the estimate is unavailable and not included";

export default function FareCalculator({ prefill, onClose }: { prefill: CalculatorPrefill; onClose: () => void }) {
  const router = useRouter();
  const dialog = useRef<HTMLDivElement>(null);
  const [token] = useState(newKey);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const [tripType, setTripType] = useState<"distance" | "hourly">("distance");
  const [hours, setHours] = useState("3");
  const [pickup, setPickup] = useState<PlaceValue>({ text: prefill.pickup ?? "" });
  const [dropoff, setDropoff] = useState<PlaceValue>({ text: prefill.dropoff ?? "" });
  const [stops, setStops] = useState<{ id: number; v: PlaceValue }[]>([]);
  const [date, setDate] = useState(prefill.date ?? "");
  const [time, setTime] = useState(prefill.time ?? "");
  const [passengers, setPassengers] = useState("2");
  const [promo, setPromo] = useState("");
  const [roundTrip, setRoundTrip] = useState(false);
  const [retDate, setRetDate] = useState("");
  const [retTime, setRetTime] = useState("");
  const [retPickup, setRetPickup] = useState<PlaceValue>(empty);
  const [retDropoff, setRetDropoff] = useState<PlaceValue>(empty);
  const [meetGreet, setMeetGreet] = useState(false); // not part of the fare request: its fee comes from the chosen vehicle's tier
  const [seats, setSeats] = useState<ChildSeats>({ rear_facing: 0, front_facing: 0, booster: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ text: string; unconfigured?: boolean } | null>(null);
  const [result, setResult] = useState<FareResponse | null>(null);
  const [lastTrip, setLastTrip] = useState<TripPayload | null>(null);
  const [routeKey, setRouteKey] = useState<RouteKey>("fastest");
  const [vehicleId, setVehicleId] = useState("");
  const [panel, setPanel] = useState<"summary" | "quote" | "sent">("summary");
  const nextStop = useRef(1);
  const [today] = useState(() => new Date().toISOString().slice(0, 10));

  const payload = useMemo<TripPayload>(() => ({
    pickup, dropoff, stops: stops.map((s) => s.v).filter((s) => s.text.trim()), date, time, tripType,
    hours: tripType === "hourly" ? Number(hours) : null, passengers: Number(passengers) || 0, promoCode: promo.trim() || null,
    // The return journey defaults to the outbound trip reversed; the server validates and prices both legs.
    childSeats: seats,
    returnLeg: roundTrip && tripType === "distance" ? { pickup: retPickup.text.trim() ? retPickup : dropoff, dropoff: retDropoff.text.trim() ? retDropoff : pickup, date: retDate, time: retTime } : null,
  }), [pickup, dropoff, stops, date, time, tripType, hours, passengers, promo, roundTrip, retDate, retTime, retPickup, retDropoff, seats]);
  const stale = lastTrip !== null && JSON.stringify(lastTrip) !== JSON.stringify(payload);

  // Dialog behaviour: focus, escape, scroll lock, simple focus trap.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLElement>("input")?.focus();
    // Escape closes even when focus has moved outside the dialog (for example onto the page behind a scrim tap).
    const onDocKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    document.addEventListener("keydown", onDocKey);
    return () => { document.body.style.overflow = ""; document.removeEventListener("keydown", onDocKey); prev?.focus?.(); };
  }, []);
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Tab" || !dialog.current) return;
    const els = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  const seatCount0 = SEAT_TYPES.reduce((n, t) => n + (lastTrip?.childSeats?.[t] ?? 0), 0);
  const route = result?.routes.find((r) => r.key === routeKey) ?? result?.routes[0] ?? null;
  const vehicle: VehicleOptionDto | undefined = result?.vehicles.find((v) => v.id === vehicleId);
  const quote = vehicle?.quotes[route?.key ?? "fastest"] ?? null;
  // What is charged ONLINE (display only; the server recalculates it): fixed tier price + Meet & Greet + child seats.
  // The trip estimate (mileage/hours/tolls) is shown separately and is never added to it.
  const tp = vehicle?.tierPricing ?? null;
  const seatFee = result?.seatFeeCents ?? 0;
  const mgOffered = !meetGreet || (tp?.meetGreetFeeCents != null);
  const mgFee = meetGreet && tp?.meetGreetFeeCents != null ? tp.meetGreetFeeCents : 0;
  const onlineTotal = tp?.fixedPriceCents != null && mgOffered ? tp.fixedPriceCents + mgFee + seatFee : null;

  async function getFares(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    setPanel("summary");
    try {
      const res = await fetch("/api/fare/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError({ text: data.error ?? "Something went wrong. Please try again.", unconfigured: data.code === "not_configured" });
        setResult(null);
      } else {
        const r = data as FareResponse;
        setResult(r);
        setLastTrip(payload);
        setRouteKey("fastest");
        setVehicleId((r.vehicles.find((v) => v.quotable) ?? r.vehicles[0])?.id ?? "");
      }
    } catch {
      setError({ text: "Could not reach the server. Check your connection and try again." });
    }
    setLoading(false);
  }

  function continueToBooking() {
    if (!lastTrip || !vehicle || !route || stale || !mgOffered) return;
    const stored: StoredTrip = {
      trip: { ...lastTrip, meetGreet }, vehicleId: vehicle.id, vehicleName: vehicle.name, routeKey: route.key,
      submissionKey: newKey(),
      display: {
        quote, distanceMiles: route.distanceMiles, durationMinutes: route.durationMinutes, routeLabel: route.label,
        online: tp ? { tierName: tp.name, fixedPriceCents: tp.fixedPriceCents, meetGreetCents: mgFee, seatFeeCents: seatFee } : null,
      },
    };
    try { sessionStorage.setItem(TRIP_STORAGE_KEY, JSON.stringify(stored)); } catch { /* ignore */ }
    onClose();
    router.push("/book");
  }

  // Better-quote request
  const [qr, setQr] = useState({ name: "", email: "", phone: "", budget: "", message: "", website: "" });
  const [qrState, setQrState] = useState<{ busy: boolean; error?: string; fields?: Record<string, string> }>({ busy: false });
  const [qrKey] = useState(newKey);
  async function sendQuoteRequest(e: React.FormEvent) {
    e.preventDefault();
    if (qrState.busy || !lastTrip || !vehicle || !route) return;
    setQrState({ busy: true });
    try {
      const res = await fetch("/api/quote-requests", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trip: lastTrip, vehicleId: vehicle.id, routeKey: route.key, name: qr.name, email: qr.email, phone: qr.phone, desiredBudget: qr.budget, message: qr.message, website: qr.website, submissionKey: qrKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setPanel("sent");
      else setQrState({ busy: false, error: data.error ?? "Could not send your request.", fields: data.fields });
    } catch {
      setQrState({ busy: false, error: "Could not reach the server. Please try again." });
    }
  }

  const fieldErr = (k: string) => (qrState.fields?.[k] ? <span className="field__error">{qrState.fields[k]}</span> : null);

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="calc" role="dialog" aria-modal="true" aria-labelledby="calc-title" ref={dialog} onKeyDown={onKeyDown}>
        <header className="calc__head">
          <h2 id="calc-title">Calculate your fare</h2>
          <button type="button" className="modal-close" aria-label="Close fare calculator" onClick={onClose}>×</button>
        </header>

        <div className="calc__body">
          <div className="calc__main">
            <form onSubmit={getFares} noValidate>
              <div className="seg" role="group" aria-label="Trip type">
                <button type="button" aria-pressed={tripType === "distance"} onClick={() => setTripType("distance")}>Point to point</button>
                <button type="button" aria-pressed={tripType === "hourly"} onClick={() => setTripType("hourly")}>By the hour</button>
              </div>

              <h3 className="calc__section">Where to</h3>
              <PlaceInput label="Pickup location" value={pickup} onChange={setPickup} placeholder="Address, airport or place" sessionToken={token} />
              {stops.map((s, i) => (
                <div key={s.id} className="stop">
                  <PlaceInput label={`Stop ${i + 1}`} value={s.v} onChange={(v) => setStops((list) => list.map((x) => (x.id === s.id ? { ...x, v } : x)))} placeholder="Address or place" sessionToken={token} />
                  <button type="button" className="btn btn--ghost btn-sm" aria-label={`Remove stop ${i + 1}`} onClick={() => setStops((list) => list.filter((x) => x.id !== s.id))}>Remove</button>
                </div>
              ))}
              {stops.length < 8 && <button type="button" className="linkbtn" onClick={() => setStops((l) => [...l, { id: nextStop.current++, v: empty }])}>+ Add a stop</button>}
              <PlaceInput label="Destination" value={dropoff} onChange={setDropoff} placeholder="Address, airport or place" sessionToken={token} />

              <h3 className="calc__section">When and who</h3>
              <div className="calc__row">
                <div className="field"><label htmlFor="c-date">Pickup date</label><input id="c-date" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} /></div>
                <div className="field"><label htmlFor="c-time">Pickup time</label><input id="c-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></div>
              </div>
              <div className="calc__row">
                <div className="field"><label htmlFor="c-pax">Passengers</label><input id="c-pax" type="number" min={1} max={50} value={passengers} onChange={(e) => setPassengers(e.target.value)} /></div>
                {tripType === "hourly" ? (
                  <div className="field"><label htmlFor="c-hours">Hours booked</label><input id="c-hours" type="number" min={1} max={24} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} /></div>
                ) : (
                  <div className="field"><label htmlFor="c-promo">Promo code (optional)</label><input id="c-promo" value={promo} onChange={(e) => setPromo(e.target.value)} autoComplete="off" /></div>
                )}
              </div>
              {tripType === "distance" && (
                <div className="roundtrip">
                  <label className="choice"><input type="checkbox" checked={roundTrip} onChange={(e) => setRoundTrip(e.target.checked)} /><span><strong>Round trip</strong><br /><small className="muted">Add a return journey. Both legs are priced and shown separately; any round-trip discount is applied automatically when one is active.</small></span></label>
                  {roundTrip && (
                    <fieldset className="fieldset" style={{ marginTop: ".75rem" }}>
                      <legend>Return trip</legend>
                      <PlaceInput label="Return pickup (defaults to your destination)" value={retPickup} onChange={setRetPickup} placeholder={dropoff.text || "Address, airport or place"} sessionToken={token} />
                      <PlaceInput label="Return destination (defaults to your pickup)" value={retDropoff} onChange={setRetDropoff} placeholder={pickup.text || "Address, airport or place"} sessionToken={token} />
                      <div className="calc__row">
                        <div className="field"><label htmlFor="c-rdate">Return date</label><input id="c-rdate" type="date" min={date || today} value={retDate} onChange={(e) => setRetDate(e.target.value)} /></div>
                        <div className="field"><label htmlFor="c-rtime">Return pickup time</label><input id="c-rtime" type="time" value={retTime} onChange={(e) => setRetTime(e.target.value)} /></div>
                      </div>
                    </fieldset>
                  )}
                </div>
              )}
              {tripType === "hourly" && (
                <div className="field"><label htmlFor="c-promo2">Promo code (optional)</label><input id="c-promo2" value={promo} onChange={(e) => setPromo(e.target.value)} autoComplete="off" />
                  <span className="help muted">Hourly bookings include a mileage allowance. Extra miles are charged separately and itemized in your quote.</span></div>
              )}

              <h3 className="calc__section">Extras</h3>
              <div className="meetgreet">
                <label className="choice">
                  <input type="checkbox" checked={meetGreet} onChange={(e) => setMeetGreet(e.target.checked)} aria-describedby="mg-help" />
                  <span><strong>Airport Meet &amp; Greet — Optional paid service</strong><br />
                    <small id="mg-help" className="muted">Your driver meets the passenger inside the airport. The fee depends on your vehicle&apos;s tier{result?.tiers?.some((t) => t.meetGreetFeeCents != null) ? `: ${result.tiers.filter((t) => t.meetGreetFeeCents != null).map((t) => `${t.name} ${formatMoney(t.meetGreetFeeCents!)}`).join(", ")}` : ""}. It is requested here and confirmed by Vanta.</small>
                  </span>
                </label>
              </div>
              <fieldset className="fieldset seats">
                <legend>Child car seats (optional)</legend>
                <p className="muted">{result?.seatInfo ? `${formatMoney(result.seatInfo.oneWayCents)} per seat one way, ${formatMoney(result.seatInfo.roundTripCents)} per seat for a round trip (charged once for the whole round trip). Seats are charged online with the fixed price.` : "The seat fee is charged online as an add-on and is shown separately from the trip estimate."} {SEAT_CONFIRMATION_NOTE}</p>
                <div className="seats__grid">
                  {SEAT_TYPES.map((t: SeatType) => (
                    <div className="field" key={t}>
                      <label htmlFor={`seat-${t}`}>{SEAT_LABEL[t]}</label>
                      <input id={`seat-${t}`} type="number" inputMode="numeric" min={0} max={result?.seatInfo?.max ?? 4} value={seats[t]} onChange={(e) => setSeats((s0) => ({ ...s0, [t]: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))} />
                    </div>
                  ))}
                </div>
              </fieldset>

              <button className="btn btn--primary" style={{ width: "100%", marginTop: "1rem" }} disabled={loading}>{loading ? "Calculating route…" : result ? "Update fares" : "Get fares"}</button>
              <div role="alert" aria-live="polite">
                {error && (
                  <div className="notice notice--error">
                    {error.text}
                    {error.unconfigured && <> <Link href="/contact?topic=quote#form" onClick={onClose} style={{ textDecoration: "underline" }}>Send us your trip details</Link>.</>}
                  </div>
                )}
              </div>
            </form>

          </div>

          <aside className="calc__side" aria-label="Fares, vehicles and route">
            {!result && (
              <>
                <RouteMap polyline={null} />
                <p className="muted" style={{ marginTop: "1rem" }}>Enter your trip and choose <strong>Get fares</strong>. Your vehicle choices, with photos and prices, appear here so you can compare and select one without leaving this window.</p>
              </>
            )}

            {result && (
              <section aria-label="Routes and vehicles">
                {result.promo && <div className={`notice ${result.promo.applied ? "notice--ok" : "notice--error"}`}>{result.promo.applied ? `Promo applied: ${result.promo.label}` : "That promo code is not valid, so it was not applied."}</div>}
                {result.routes.length > 1 && (
                  <fieldset className="opts">
                    <legend>Route</legend>
                    {result.routes.map((r) => {
                      const alt = vehicle?.quotes[r.key]; const base = vehicle?.quotes.fastest;
                      const diff = alt && base && r.key !== "fastest" ? alt.totalCents - base.totalCents : null;
                      return (
                        <label key={r.key} className={`opt${routeKey === r.key ? " is-on" : ""}`}>
                          <input type="radio" name="route" checked={routeKey === r.key} onChange={() => setRouteKey(r.key)} />
                          <span><strong>{r.label}</strong><br /><small>{r.distanceMiles} mi · about {r.durationMinutes} min · {tollText(r.toll.status, r.toll.amount)}</small></span>
                          {alt && <span className="opt__price">{formatMoney(alt.totalCents, alt.currency)}{diff != null && diff !== 0 && <small> ({diff > 0 ? "+" : "−"}{formatMoney(Math.abs(diff))} vs fastest)</small>}</span>}
                        </label>
                      );
                    })}
                  </fieldset>
                )}
                <fieldset className="vgrid">
                  <legend>Choose your vehicle</legend>
                  {result.vehicles.length === 0 && <p className="muted">No vehicle fits {payload.passengers} passengers online. Please contact us for a larger option.</p>}
                  <ul>
                    {result.vehicles.map((v) => {
                      const q = v.quotes[route?.key ?? "fastest"];
                      const on = vehicleId === v.id;
                      return (
                        <li key={v.id}>
                          <label className={`vcard${on ? " is-on" : ""}`}>
                            <input type="radio" name="vehicle" className="sr-only" checked={on} onChange={() => { setVehicleId(v.id); setPanel("summary"); }} />
                            <VehiclePhoto src={v.image} name={v.name} width={640} height={400} sizes="(max-width: 860px) 100vw, 320px" />
                            <span className="vcard__body">
                              <strong className="vcard__name">{v.name}</strong>
                              <span className="vcard__meta">{v.tier && <span className="tier-badge">{v.tier}</span>}<span>{v.capacityLabel || `Up to ${v.passengers} passengers`}</span></span>
                              {(v.description || v.similarModels) && <span className="vcard__desc">{v.description || v.similarModels}</span>}
                              <span className="vcard__foot">
                                <span className="vcard__prices">
                                  <span className="vcard__price">{v.tierPricing?.fixedPriceCents != null ? formatMoney(v.tierPricing.fixedPriceCents) : <small>Fixed price to be confirmed</small>}</span>
                                  <small className="vcard__sub">{v.tier ? `Fixed ${v.tier} price, charged online` : "Price on request"}</small>
                                  {q && <small className="vcard__sub">Estimated trip fare {formatMoney(q.totalCents, q.currency)} (information only)</small>}
                                </span>
                                <span className="vcard__select">{on ? "✓ Selected" : "Select"}</span>
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              </section>
            )}

            {result?.region?.manualReview && (
              <div className="notice" role="status">This trip is outside our primary DMV area ({result.region.label}). You can still request it: our team reviews it manually and may fulfil it with an approved partner, subject to availability and confirmation.</div>
            )}

            {result && !result.pricingAvailable && (
              <div className="notice">Online pricing is not available for these vehicles yet. You can still send a booking request and we will confirm the price with you.</div>
            )}

            {result && vehicle && panel === "summary" && (
              <div className="summary">
                <h3>{vehicle.name}</h3>
                <p className="muted">{[vehicle.tier, vehicle.capacityLabel].filter(Boolean).join(" · ")}{lastTrip?.returnLeg ? " · Round trip" : ""}</p>
                {seatCount0 > 0 && <p className="muted">{SEAT_CONFIRMATION_NOTE}</p>}
                <h4 className="summary__h">Charged online</h4>
                {tp?.fixedPriceCents != null ? (
                  <table className="lines" aria-label="Amount charged online"><tbody>
                    <tr><td>Fixed {tp.name} price</td><td>{formatMoney(tp.fixedPriceCents)}</td></tr>
                    {meetGreet && tp.meetGreetFeeCents != null && <tr><td>Airport Meet &amp; Greet<span className="tag">requested</span></td><td>{formatMoney(tp.meetGreetFeeCents)}</td></tr>}
                    {seatFee > 0 && <tr><td>Child car seats</td><td>{formatMoney(seatFee)}</td></tr>}
                    {onlineTotal != null && <tr className="total"><td>Total due online</td><td>{formatMoney(onlineTotal)}</td></tr>}
                  </tbody></table>
                ) : <p className="muted">The fixed price for {tp?.name ?? "this vehicle"} has not been set yet, so online payment is not available for it. You can still send a booking request and we will confirm the price with you.</p>}
                {meetGreet && !mgOffered && <div className="notice notice--error" role="alert">Meet &amp; Greet is not offered for the {tp?.name ?? "selected"} tier. Untick it to continue, or choose another vehicle.</div>}
                {meetGreet && mgOffered && <p className="muted">Meet &amp; Greet is a request until Vanta confirms it. Its fee is charged once, with the fixed price.</p>}

                <h4 className="summary__h">Estimated trip fare</h4>
                {quote ? (
                  <>
                    <p className="muted">Calculated from distance, time and tolls for information. It is <strong>not</strong> charged through online payment.</p>
                    <details>
                      <summary>How the estimate is calculated</summary>
                      <table className="lines"><tbody>
                        {quote.lineItems.map((l, i) => (
                          <tr key={i}><td>{l.label}{l.detail && <small className="muted"><br />{l.detail}</small>}</td><td>{l.cents < 0 ? "−" : ""}{formatMoney(Math.abs(l.cents), quote.currency)}</td></tr>
                        ))}
                      </tbody></table>
                    </details>
                    <table className="lines"><tbody><tr className="total"><td>Estimated trip fare</td><td>{formatMoney(quote.totalCents, quote.currency)}</td></tr></tbody></table>
                    {quote.roundTrip && (
                      <p className="muted">
                        {quote.roundTrip.legs.map((l) => `${l.label} ${formatMoney(l.totalCents, quote.currency)}`).join(" · ")}. Two separate one-way trips: {formatMoney(quote.roundTrip.twoOneWayCents, quote.currency)}.{" "}
                        {quote.roundTrip.discountCents > 0 ? `Round-trip discount: ${formatMoney(quote.roundTrip.discountCents, quote.currency)}.` : "No round-trip discount is currently active."}
                      </p>
                    )}
                    {quote.tollStatus === "unavailable" && <p className="muted">Toll costs could not be estimated for this route and are not included.</p>}
                    <p className="muted">Your booking is confirmed only when we confirm it with you.</p>
                  </>
                ) : <p className="muted">An estimate is not available for this vehicle. We will confirm the price when we reply to your booking request.</p>}

                {stale && <div className="notice">Trip details changed. Update fares to continue.</div>}
                <button className="btn btn--primary" style={{ width: "100%" }} onClick={continueToBooking} disabled={stale || !mgOffered}>Continue to booking</button>
                <p className="muted" style={{ marginTop: ".75rem" }}>Need a custom price or something unusual? <Link href="/quote" onClick={onClose} style={{ textDecoration: "underline" }}>GET A QUOTE</Link></p>
                {quote && (
                  <div className="dontlike">
                    <p><strong>Don&apos;t like the estimate?</strong> You can send us a query. {BETTER_QUOTE_DISCLAIMER}</p>
                    <button className="btn btn--ghost" style={{ width: "100%" }} onClick={() => setPanel("quote")} disabled={stale}>Request a Better Quote</button>
                  </div>
                )}
              </div>
            )}

            {result && vehicle && panel === "quote" && (
              <form className="summary" onSubmit={sendQuoteRequest} noValidate>
                <h3>Request a better quote</h3>
                <p className="muted">Your trip, vehicle and current quote ({quote ? formatMoney(quote.totalCents, quote.currency) : "n/a"}) are included automatically.</p>
                <div className="field"><label htmlFor="q-name">Name</label><input id="q-name" value={qr.name} onChange={(e) => setQr({ ...qr, name: e.target.value })} autoComplete="name" />{fieldErr("name")}</div>
                <div className="field"><label htmlFor="q-email">Email</label><input id="q-email" type="email" value={qr.email} onChange={(e) => setQr({ ...qr, email: e.target.value })} autoComplete="email" />{fieldErr("email")}</div>
                <div className="field"><label htmlFor="q-phone">Phone</label><input id="q-phone" type="tel" value={qr.phone} onChange={(e) => setQr({ ...qr, phone: e.target.value })} autoComplete="tel" />{fieldErr("phone")}</div>
                <div className="field"><label htmlFor="q-budget">Your budget in dollars (optional)</label><input id="q-budget" type="number" min={0} value={qr.budget} onChange={(e) => setQr({ ...qr, budget: e.target.value })} />{fieldErr("desiredBudget")}</div>
                <div className="field"><label htmlFor="q-msg">Message (optional)</label><textarea id="q-msg" value={qr.message} onChange={(e) => setQr({ ...qr, message: e.target.value })} /></div>
                <div className="hp" aria-hidden="true"><label htmlFor="q-web">Leave empty</label><input id="q-web" tabIndex={-1} autoComplete="off" value={qr.website} onChange={(e) => setQr({ ...qr, website: e.target.value })} /></div>
                <p className="notice" role="note"><strong>Please note.</strong> {BETTER_QUOTE_DISCLAIMER}</p>
                <button className="btn btn--primary" style={{ width: "100%" }} disabled={qrState.busy}>{qrState.busy ? "Sending…" : "Send request"}</button>
                <button type="button" className="btn btn--ghost" style={{ width: "100%", marginTop: ".5rem" }} onClick={() => setPanel("summary")}>Back to my quote</button>
                <div role="alert">{qrState.error && <div className="notice notice--error">{qrState.error}</div>}</div>
              </form>
            )}

            {result && route && (
              <div style={{ marginTop: "1.25rem" }}>
                <RouteMap polyline={route.polyline ?? null} />
                <p className="muted" style={{ margin: ".6rem 0" }}>{route.distanceMiles} miles · about {route.durationMinutes} minutes · {route.label}</p>
              </div>
            )}

            {panel === "sent" && (
              <div className="summary">
                <div className="notice notice--ok" role="status"><strong>Request sent.</strong> We will review it and reply. </div>
                <p className="notice" role="note">{BETTER_QUOTE_REMINDER}</p>
                <button className="btn btn--ghost" style={{ width: "100%", marginTop: "1rem" }} onClick={onClose}>Close</button>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
