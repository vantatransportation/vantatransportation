import Link from "next/link";
import { notFound } from "next/navigation";
import FieldsForm from "@/components/admin/FieldsForm";
import NotesPanel, { type NoteRow } from "@/components/admin/NotesPanel";
import { fmtDate, fmtMoney, label } from "@/components/admin/util";
import { adminPage, loadRefOptions } from "@/lib/admin/data";
import { resources, toClient } from "@/lib/admin/resources";
import { BUSINESS_TZ } from "@/lib/config";
import BookingOps from "@/components/admin/BookingOps";
import BookingWorkflow from "@/components/admin/BookingWorkflow";
import { DRIVER_FLOW, canTransition, type BookingStatus } from "@/lib/booking-status";
import { getHelpline } from "@/lib/helpline";
import { loadBookingSettings } from "@/lib/policies";
import { REGION_LABEL, type Region } from "@/lib/coverage";

export const metadata = { title: "Booking" };
const UUID_RE = /^[0-9a-f-]{36}$/i;

export default async function BookingDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const { db } = await adminPage();
  const { data: b } = await db.from("bookings").select("*, customers(id,name,email,phone), vehicles(name), vehicle_tiers(name)").eq("id", id).maybeSingle();
  if (!b) notFound();
  const [payQ, legsQ, peopleQ, airportQ, settings] = await Promise.all([
    db.from("payments").select("id,kind,provider,provider_ref,provider_txn_id,status,amount_cents,refunded_cents,currency,failure_reason,created_at,paid_at").eq("booking_id", id).order("created_at", { ascending: false }),
    db.from("booking_legs").select("leg_number,direction,pickup_address,dropoff_address,pickup_at,distance_miles,fare_cents").eq("booking_id", id).order("leg_number"),
    db.from("booking_people").select("role,full_name,phone,email,relationship").eq("booking_id", id).order("created_at"),
    db.from("booking_airport_details").select("*").eq("booking_id", id),
    loadBookingSettings(db),
  ]);
  const payments = (payQ.data ?? []) as { id: string; kind: string; provider: string; provider_ref: string | null; provider_txn_id: string | null; status: string; amount_cents: number; refunded_cents: number; currency: string; failure_reason: string | null; created_at: string; paid_at: string | null }[];
  const seats = (Array.isArray(b.child_seats) ? b.child_seats : []) as { type: string; quantity: number }[];
  const legs = (legsQ.data ?? []) as { leg_number: number; direction: string; pickup_address: string; dropoff_address: string | null; pickup_at: string; distance_miles: number | null; fare_cents: number | null }[];
  const people = (peopleQ.data ?? []) as { role: string; full_name: string; phone: string | null; email: string | null; relationship: string | null }[];
  const airports = (airportQ.data ?? []) as Record<string, string | number | boolean | null>[];
  const passenger = people.find((x) => x.role === "passenger");
  const contacts = people.filter((x) => x.role === "emergency_contact" || x.role === "secondary_contact");
  const [driversQ, histQ, helpline] = await Promise.all([
    db.from("drivers").select("id,full_name,vehicle_plate,is_active").order("full_name"),
    db.from("booking_status_history").select("to_status,note,created_at,actor_type").eq("booking_id", id).order("created_at", { ascending: false }).limit(50),
    getHelpline(db),
  ]);
  const driverRows = (driversQ.data ?? []) as { id: string; full_name: string; vehicle_plate: string | null; is_active: boolean }[];
  const [stops, snaps, notes, refs] = await Promise.all([
    db.from("booking_stops").select("position,address").eq("booking_id", id).order("position"),
    db.from("pricing_snapshots").select("line_items,total_cents,snapshot,created_at").eq("booking_id", id).order("created_at"),
    db.from("crm_notes").select("id,body,created_at").eq("entity_type", "booking").eq("entity_id", id).order("created_at", { ascending: false }),
    loadRefOptions(db, resources.bookings),
  ]);
  const cust = b.customers as { id: string; name: string; email: string | null; phone: string | null } | null;
  const snap = (snaps.data ?? [])[0] as { line_items: { label: string; cents: number; detail?: string }[]; total_cents: number; snapshot: { override?: { priceCents: number; originalTotalCents: number | null } } } | undefined;

  return (
    <>
      <p><Link href="/admin/bookings" className="muted">← Bookings</Link></p>
      <h1>Booking {b.reference}</h1>
      <p className="adm-sub"><span className="pill">{label(b.status)}</span> · Received {fmtDate(b.created_at, BUSINESS_TZ)}</p>
      <div className="panel">
        <h3>Pricing and payment</h3>
        <dl className="kv">
          <dt>Tier</dt><dd>{b.tier_name ?? "Not recorded"}</dd>
          <dt>Estimated trip fare</dt><dd>{b.estimated_fare_cents != null ? fmtMoney(b.estimated_fare_cents) : "To be confirmed"} <span className="muted">(calculated from mileage/hours/tolls; information only, not charged online)</span></dd>
          <dt>Charged online</dt><dd>{b.online_amount_cents != null ? `${fmtMoney(b.online_amount_cents)} = fixed tier price ${fmtMoney(b.fixed_price_cents ?? 0)}${b.meet_greet_selected ? ` + Meet & Greet ${fmtMoney(b.meet_greet_fee_cents ?? 0)}` : ""}${(b.child_seat_fee_cents ?? 0) > 0 ? ` + child seats ${fmtMoney(b.child_seat_fee_cents)}` : ""}` : "Not set up (tier fixed price was not configured when this was requested)"}</dd>
          <dt>Meet &amp; Greet</dt><dd>{b.meet_greet_selected ? "Selected (fee frozen at request time)" : "Not selected"}</dd>
          <dt>Payment status</dt><dd>{String(b.payment_status).replace(/_/g, " ")} · collected {fmtMoney(b.amount_paid_cents ?? 0)}</dd>
          <dt>Confirmed</dt><dd>{b.confirmed_at ? `Yes, ${fmtDate(b.confirmed_at, BUSINESS_TZ)} (after verified payment)` : "Not yet"}</dd>
          <dt>Tracking ID</dt><dd>{b.tracking_code ?? "Not generated (apply migration 0009)"} <span className="muted">(customer credential; share it only with the customer)</span></dd>
          <dt>Child seats</dt><dd>{seats.length ? `${seats.map((x) => `${x.quantity} × ${x.type.replace(/_/g, "-")}`).join(", ")} (requested, subject to confirmation)` : "None requested"}</dd>
        </dl>
        {payments.length > 0 && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Date</th><th>Provider</th><th>Type</th><th>Amount</th><th>Status</th><th>Reference</th></tr></thead><tbody>
          {payments.map((p) => <tr key={p.id}><td>{fmtDate(p.paid_at ?? p.created_at, BUSINESS_TZ)}</td><td>{p.provider === "paypal" ? "PayPal" : "Stripe"}</td><td>{p.kind}</td><td>{fmtMoney(p.amount_cents)}{p.refunded_cents > 0 ? ` (refunded ${fmtMoney(p.refunded_cents)})` : ""}</td><td>{p.status}{p.failure_reason ? ` · ${p.failure_reason}` : ""}</td><td><code>{p.provider_txn_id ?? p.provider_ref ?? ""}</code></td></tr>)}
        </tbody></table></div>}
        <p className="muted">A booking is confirmed only by a payment the provider has verified (Stripe webhook signature, or PayPal verification): never by an admin click or a customer returning to a page. Refunds are never automatic; issue them in the Stripe or PayPal dashboard and they appear here.</p>
      </div>
      {!helpline && <div className="banner">The Vanta support phone number is not set. Customers and drivers cannot see a Call Vanta Support button until you add it in Website content (contact.phone). <Link href="/admin/content" style={{ textDecoration: "underline" }}>Website content</Link></div>}
      <BookingWorkflow id={id} status={b.status} driverId={b.driver_id ?? null} driverName={driverRows.find((d) => d.id === b.driver_id)?.full_name ?? null} paymentReleased={Boolean(b.payment_released_at && b.driver_id)}
        nextSteps={DRIVER_FLOW.filter((to) => to !== "assigned" && canTransition("admin", b.status as BookingStatus, to))} confirmedAt={b.confirmed_at ?? null}
        drivers={driverRows.map((d) => ({ id: d.id, name: d.full_name, plate: d.vehicle_plate, active: d.is_active }))}
        history={((histQ.data ?? []) as { to_status: string; note: string | null; created_at: string; actor_type: string }[]).map((h) => ({ to: h.to_status, at: h.created_at, note: h.note, actor: h.actor_type }))} />
      <div className="twocol">
        <div className="panel">
          <h3>Trip</h3>
          <dl className="kv">
            <dt>Customer</dt><dd>{cust ? <Link href={`/admin/customers/${cust.id}`} style={{ textDecoration: "underline" }}>{cust.name}</Link> : ""}</dd>
            <dt>Contact</dt><dd>{[cust?.phone, cust?.email].filter(Boolean).join(" · ")}</dd>
            <dt>Pickup time</dt><dd>{fmtDate(b.pickup_at, BUSINESS_TZ)}</dd>
            <dt>Pickup</dt><dd>{b.pickup_address}</dd>
            {((stops.data ?? []) as { position: number; address: string }[]).map((s) => [<dt key={`k${s.position}`}>Stop {s.position}</dt>, <dd key={`v${s.position}`}>{s.address}</dd>])}
            <dt>Destination</dt><dd>{b.dropoff_address}</dd>
            <dt>Trip type</dt><dd>{b.trip_type === "hourly" ? `Hourly (${b.hours} h)` : "Point to point"}</dd>
            <dt>Passengers</dt><dd>{b.passengers}</dd>
            <dt>Vehicle</dt><dd>{(b.vehicles as { name: string } | null)?.name} {(b.vehicle_tiers as { name: string } | null)?.name ? `(${(b.vehicle_tiers as { name: string }).name})` : ""}</dd>
            <dt>Route</dt><dd>{b.distance_miles} mi, about {b.duration_minutes} min{b.avoid_tolls ? ", avoiding tolls" : ""}</dd>
            {b.source_quote_request_id && <><dt>From quote</dt><dd><Link href={`/admin/quotes/${b.source_quote_request_id}`} style={{ textDecoration: "underline" }}>View quote request</Link></dd></>}
          </dl>
        </div>
        <div className="panel">
          <h3>Price at time of booking</h3>
          {snap ? (
            <>
              <div className="tbl-wrap"><table className="tbl"><tbody>
                {snap.line_items.map((l, i) => <tr key={i}><td>{l.label}{l.detail && <span className="muted"> ({l.detail})</span>}</td><td style={{ textAlign: "right" }}>{fmtMoney(l.cents)}</td></tr>)}
                <tr><td><strong>Total quoted</strong></td><td style={{ textAlign: "right" }}><strong>{fmtMoney(snap.total_cents)}</strong></td></tr>
              </tbody></table></div>
              {snap.snapshot.override && <p className="muted">Agreed price (revised quote): {fmtMoney(snap.snapshot.override.priceCents)}</p>}
              <p className="muted">This snapshot is frozen and does not change when rates are edited.</p>
            </>
          ) : <p className="muted">No price was quoted online (pricing was not published for this vehicle). Current fare: {fmtMoney(b.estimated_fare_cents) || "to be confirmed"}.</p>}
        </div>
      </div>
      <div className="panel">
        <h3>Coverage and fulfilment</h3>
        <dl className="kv">
          <dt>Service region</dt><dd>{REGION_LABEL[(b.service_region ?? "unknown") as Region]}</dd>
          <dt>Fulfilment</dt><dd>{b.fulfilment_mode === "partner" ? `Approved partner${b.partner_name ? `: ${b.partner_name}` : ""}` : b.fulfilment_mode === "vanta" ? "Vanta" : "Needs staff review"}</dd>
          {b.requires_manual_review && <><dt>Staff review</dt><dd>{b.review_reason ?? "Required"}</dd></>}
          <dt>Trip</dt><dd>{b.trip_direction === "round_trip" ? "Round trip" : "One way"}</dd>
          <dt>Policies</dt><dd>{b.policies_acknowledged_at ? `Customer confirmed they read the waiting-time and no-show policies on ${fmtDate(b.policies_acknowledged_at, BUSINESS_TZ)}` : "Not recorded (for example a quote conversion)"}</dd>
        </dl>
      </div>
      {legs.length > 0 && b.trip_direction === "round_trip" && (
        <div className="panel"><h3>Journey legs</h3><div className="tbl-wrap"><table className="tbl"><thead><tr><th>Leg</th><th>Pickup time</th><th>Route</th><th>Leg fare</th></tr></thead><tbody>
          {legs.map((l) => <tr key={l.leg_number}><td>{label(l.direction)}</td><td>{fmtDate(l.pickup_at, BUSINESS_TZ)}</td><td>{l.pickup_address} → {l.dropoff_address}</td><td>{fmtMoney(l.fare_cents)}</td></tr>)}
        </tbody></table></div></div>
      )}
      <div className="twocol">
        <div className="panel">
          <h3>Booker and passenger</h3>
          <dl className="kv">
            <dt>Booked by</dt><dd>{cust?.name} · {[cust?.phone, cust?.email].filter(Boolean).join(" · ")}</dd>
            <dt>Travelling</dt><dd>{b.booking_for === "other" && passenger ? `${passenger.full_name} · ${[passenger.phone, passenger.email].filter(Boolean).join(" · ")}` : "The person who booked"}</dd>
            <dt>Luggage</dt><dd>{b.luggage_count ?? "Not given"}</dd>
            {b.assistance_notes && <><dt>Assistance</dt><dd>{b.assistance_notes}</dd></>}
            {b.pickup_instructions && <><dt>Pickup instructions</dt><dd>{b.pickup_instructions}</dd></>}
          </dl>
        </div>
        <div className="panel">
          <h3>Emergency and secondary contacts</h3>
          {contacts.length === 0 ? <p className="muted">None provided.</p> : <dl className="kv">{contacts.map((c, i) => [<dt key={`k${i}`}>{c.role === "secondary_contact" ? "Secondary" : "Emergency"}</dt>, <dd key={`v${i}`}>{c.full_name}{c.relationship ? ` (${c.relationship})` : ""} · {c.phone}</dd>])}</dl>}
          <p className="muted">Contact details for this trip only. Not monitoring or tracking. Never used for promotions.</p>
        </div>
      </div>
      {airports.map((a, i) => (
        <div className="panel" key={i}>
          <h3>Airport details</h3>
          <dl className="kv">
            <dt>Airport</dt><dd>{String(a.airport)} ({a.flight_direction === "departure" ? "departure" : "arrival"})</dd>
            <dt>Flight</dt><dd>{[a.airline, a.flight_number].filter(Boolean).join(" ")} {a.flight_date ? `· ${a.flight_date}` : ""} {a.flight_time ? `at ${a.flight_time}` : ""} {a.terminal ? `· Terminal ${a.terminal}` : ""}</dd>
            <dt>Passenger name</dt><dd>{String(a.passenger_name ?? "")}</dd>
            {a.pickup_instructions && <><dt>Instructions</dt><dd>{String(a.pickup_instructions)}</dd></>}
            <dt>Meet &amp; Greet</dt><dd>{a.meet_greet_requested ? (a.meet_greet_status === "confirmed" ? "Confirmed by Vanta" : a.meet_greet_status === "declined" ? "Declined" : "Requested, not yet confirmed") : "Not requested"}{a.meet_greet_requested && a.meet_greet_charge_cents == null ? " · no fee recorded" : a.meet_greet_charge_cents != null ? ` · ${fmtMoney(a.meet_greet_charge_cents)}` : ""}</dd>
          </dl>
        </div>
      ))}
      {(b.waiting_charge_status !== "none" || b.no_show_at) && (
        <div className="panel">
          <h3>Waiting and no-show records</h3>
          <dl className="kv">
            {b.waiting_charge_status !== "none" && <><dt>Waiting</dt><dd>{b.waiting_minutes_billed ?? 0} billable min · {b.waiting_charge_cents != null ? fmtMoney(b.waiting_charge_cents) : "no charge set"} · {b.waiting_charge_status}</dd></>}
            {b.no_show_at && <><dt>No-show</dt><dd>{fmtDate(b.no_show_at, BUSINESS_TZ)} by {b.no_show_marked_by_email ?? "staff"} · {b.no_show_reason} · {b.no_show_charge_cents != null ? fmtMoney(b.no_show_charge_cents) : "no charge set"} · {b.no_show_charge_status}</dd></>}
          </dl>
        </div>
      )}
      <BookingOps id={id} status={b.status} fulfilmentMode={b.fulfilment_mode ?? "review"} partnerName={b.partner_name ?? null} hasMeetGreet={airports.some((a) => a.meet_greet_requested)} meetGreetStatus={(airports.find((a) => a.meet_greet_requested)?.meet_greet_status as string | undefined) ?? null} waitingIncluded={settings.waitingIncludedMinutes} waitingRateApproved={settings.waitingRateCents != null} />
      {b.notes && <div className="panel"><h3>Customer notes</h3><p>{b.notes}</p></div>}
      <h2>Manage</h2>
      <FieldsForm resource={toClient(resources.bookings)} id={id} initial={b} refOptions={refs} tz={BUSINESS_TZ} only={["vehicle_id", "pickup_address", "dropoff_address", "pickup_at", "passengers", "estimated_fare_cents", "admin_notes"]} />
      <NotesPanel entityType="booking" entityId={id} notes={(notes.data ?? []) as NoteRow[]} tz={BUSINESS_TZ} />
    </>
  );
}
