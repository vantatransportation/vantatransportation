import Link from "next/link";
import { notFound } from "next/navigation";
import FieldsForm from "@/components/admin/FieldsForm";
import NotesPanel, { type NoteRow } from "@/components/admin/NotesPanel";
import QuoteActions from "@/components/admin/QuoteActions";
import { fmtDate, fmtMoney, label } from "@/components/admin/util";
import { adminPage } from "@/lib/admin/data";
import { resources, toClient } from "@/lib/admin/resources";
import { BUSINESS_TZ } from "@/lib/config";
import { REGION_LABEL, type Region } from "@/lib/coverage";
import { attachVehicleTiers } from "@/lib/vehicle-tiers";

export const metadata = { title: "Quote request" };
const UUID_RE = /^[0-9a-f-]{36}$/i;

export default async function QuoteDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const { db } = await adminPage();
  const { data: q } = await db.from("quote_requests").select("*, vehicles(name)").eq("id", id).maybeSingle();
  if (!q) notFound();
  const needVehicle = !q.vehicle_id;
  const [snaps, notes, fleet] = await Promise.all([
    db.from("pricing_snapshots").select("line_items,total_cents").eq("quote_request_id", id).limit(1),
    db.from("crm_notes").select("id,body,created_at").eq("entity_type", "quote_request").eq("entity_id", id).order("created_at", { ascending: false }),
    needVehicle ? db.from("vehicles").select("id,name").eq("is_active", true).order("sort_order") : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);
  // Every vehicle's assigned tiers, so staff can pick the tier when a vehicle is offered in several.
  const allVehicles = await db.from("vehicles").select("id");
  const tiered = await attachVehicleTiers(db, (allVehicles.data ?? []) as { id: string }[]);
  const tierNameById = new Map<string, string>();
  const vehicleTiers: Record<string, { id: string; name: string }[]> = {};
  for (const v of tiered) { vehicleTiers[v.id] = v.tier_ids.map((tid, i) => ({ id: tid, name: v.tier_names[i] })); for (const t of vehicleTiers[v.id]) tierNameById.set(t.id, t.name); }
  const history = (Array.isArray(q.revised_history) ? q.revised_history : []) as { priceCents: number; sentAt: string; by: string }[];
  const t = (q.trip ?? {}) as { tierId?: string | null; trip?: { pickup: { text: string }; dropoff: { text: string }; stops: { text: string }[]; pickupAtIso: string; passengers: number; tripType: string; hours: number | null }; route?: { distanceMiles: number; durationMinutes: number } };
  const trip = t.trip;
  const lines = ((snaps.data ?? [])[0] as { line_items: { label: string; cents: number; detail?: string }[]; total_cents: number } | undefined);

  return (
    <>
      <p><Link href="/admin/quotes" className="muted">← Quote requests</Link></p>
      <h1>Quote request from {q.name}</h1>
      <p className="adm-sub"><span className="pill">{label(q.status)}</span> Customer response: {label(q.customer_response)} · Received {fmtDate(q.created_at, BUSINESS_TZ)}</p>
      <div className="twocol">
        <div className="panel">
          <h3>Customer and trip</h3>
          <dl className="kv">
            <dt>Source</dt><dd>{q.source === "manual" ? "Get a Quote form (manual review)" : "Fare calculator"}</dd>
            <dt>Service region</dt><dd>{REGION_LABEL[(q.service_region ?? "unknown") as Region]}{q.service_region !== "dmv" ? " · staff review / partner fulfilment may be needed" : ""}</dd>
            <dt>Contact</dt><dd>{[q.phone, q.email].filter(Boolean).join(" · ")}</dd>
            {q.customer_id && <><dt>Customer</dt><dd><Link href={`/admin/customers/${q.customer_id}`} style={{ textDecoration: "underline" }}>Open customer record</Link></dd></>}
            <dt>Vehicle</dt><dd>{(q.vehicles as { name: string } | null)?.name ?? "Not selected"}</dd>
            {t.tierId && <><dt>Service tier</dt><dd>{tierNameById.get(t.tierId) ?? "No longer assigned to this vehicle"}</dd></>}
            {trip && <>
              <dt>When</dt><dd>{fmtDate(trip.pickupAtIso, BUSINESS_TZ)}</dd><dt>Pickup</dt><dd>{trip.pickup.text}</dd>
              {trip.stops.map((s, i) => [<dt key={`k${i}`}>Stop {i + 1}</dt>, <dd key={`v${i}`}>{s.text}</dd>])}
              <dt>Destination</dt><dd>{trip.dropoff.text}</dd><dt>Passengers</dt><dd>{trip.passengers}</dd>
              <dt>Trip type</dt><dd>{trip.tripType === "hourly" ? `Hourly (${trip.hours} h)` : "Point to point"}</dd>
            </>}
            {t.route && <><dt>Route</dt><dd>{t.route.distanceMiles} mi, about {t.route.durationMinutes} min</dd></>}
          </dl>
        </div>
        <div className="panel">
          <h3>Quote</h3>
          <dl className="kv"><dt>Original quote</dt><dd>{fmtMoney(q.original_quote_cents) || "Not available"}</dd><dt>Customer wants</dt><dd>{fmtMoney(q.desired_budget_cents) || "Not stated"}</dd>
            {q.revised_price_cents != null && <><dt>Revised price</dt><dd>{fmtMoney(q.revised_price_cents)}</dd></>}
            {history.length > 0 && <><dt>Quote history</dt><dd>{history.map((h) => `${fmtMoney(h.priceCents)} sent ${fmtDate(h.sentAt, BUSINESS_TZ)}`).join(" · ")}</dd></>}</dl>
          {q.message && <p style={{ marginTop: "1rem", whiteSpace: "pre-wrap" }}>{q.message}</p>}
          {lines && <div className="tbl-wrap" style={{ marginTop: "1rem" }}><table className="tbl"><tbody>{lines.line_items.map((l, i) => <tr key={i}><td>{l.label}</td><td style={{ textAlign: "right" }}>{fmtMoney(l.cents)}</td></tr>)}</tbody></table></div>}
        </div>
      </div>
      <h2>Review</h2>
      <p className="adm-sub">Discounts are never approved automatically. Set the decision and revised price, save, then send.</p>
      <FieldsForm resource={toClient(resources.quotes)} id={id} initial={q} tz={BUSINESS_TZ} />
      <QuoteActions id={id} email={q.email} status={q.status} converted={Boolean(q.converted_booking_id)} hasRevised={q.revised_price_cents != null} vehicles={needVehicle ? ((fleet.data ?? []) as { id: string; name: string }[]) : undefined} vehicleId={q.vehicle_id} quotedTierId={t.tierId ?? null} vehicleTiers={vehicleTiers} />
      {q.converted_booking_id && <p><Link href={`/admin/bookings/${q.converted_booking_id}`} className="btn btn--ghost">Open the booking created from this quote</Link></p>}
      <NotesPanel entityType="quote_request" entityId={id} notes={(notes.data ?? []) as NoteRow[]} tz={BUSINESS_TZ} />
    </>
  );
}
