import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";
import { createBooking } from "@/lib/fare/booking";
import type { Trip } from "@/lib/fare/trip";
import type { RouteKey } from "@/lib/fare/service";

export const runtime = "nodejs";

/** Turns an accepted revised quote into a booking request at the agreed price. */
export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const body = await readJson(request);
  const id = typeof body?.id === "string" ? body.id : "";
  const { data: q } = await g.db.from("quote_requests").select("*").eq("id", id).maybeSingle();
  if (!q) return json({ error: "Quote request not found." }, 404);
  if (q.converted_booking_id) return json({ error: "Already converted to a booking." }, 409);
  if (q.status !== "accepted") return json({ error: "Only an accepted quote can be converted. Set the status to Accepted once the customer agrees." }, 422);
  if (q.revised_price_cents == null) return json({ error: "Enter the agreed price first." }, 422);
  const vehicleId = q.vehicle_id ?? (typeof body?.vehicleId === "string" ? body.vehicleId : null);
  if (!vehicleId) return json({ error: "Choose a vehicle for this request before converting." }, 422);

  const stored = q.trip as { trip?: Trip; routeKey?: RouteKey; route?: { distanceMiles: number; durationMinutes: number; toll: { status: "none" | "known" | "unavailable"; amount: number | null; currency: string | null } } | null };
  if (!stored?.trip) return json({ error: "The stored trip details are incomplete." }, 422);

  const result = await createBooking(g.db, {
    trip: stored.trip, vehicleId, routeKey: stored.routeKey ?? "fastest",
    customer: { name: q.name, email: q.email ?? "", phone: q.phone ?? "" }, notes: q.message,
    submissionKey: `quote-${q.id}`, routeOverride: stored.route ? { ...stored.route, polyline: "" } : undefined,
    priceOverrideCents: q.revised_price_cents, quoteRequestId: q.id,
  });
  if (!result.ok) return json({ error: result.error }, result.status);

  await g.db.from("quote_requests").update({ converted_booking_id: result.id }).eq("id", q.id);
  await g.db.from("activity_logs").insert({ actor_id: g.admin.id, action: "quote.converted", entity_type: "quote_request", entity_id: q.id, meta: { booking: result.reference } });
  return json({ ok: true, bookingId: result.id, reference: result.reference });
}
