import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateQuote, type LineItem, type QuoteInput } from "@/lib/pricing/engine";
import { calculateRoundTrip, withExtras, type ExtraLine } from "@/lib/pricing/roundtrip";
import { computeRoute } from "@/lib/geo/google";
import type { ParsedRoute } from "@/lib/geo/parse";
import { findOrCreateCustomer } from "@/lib/customers";
import { classifyTrip, fulfilmentFor, type Region } from "@/lib/coverage";
import { loadActiveRoundTripRules, loadBookingSettings, loadPublicPolicies, pickRule, seatExtra } from "@/lib/policies";
import { NO_SEATS, SEAT_TYPES } from "@/lib/child-seats";
import { paymentPlan } from "@/lib/payments";
import { stripeConfigured } from "@/lib/stripe";
import type { BookingDetails } from "@/lib/booking-details";
import { loadFleet, lookupPromo, routeToInput, type RouteKey } from "./service";
import type { Trip } from "./trip";

export interface CreateBookingInput {
  trip: Trip;
  vehicleId: string;
  routeKey: RouteKey;
  customer: { name: string; email: string; phone: string };
  notes: string | null;
  submissionKey: string | null;
  /** Family-focused details. Omitted for quote conversions. */
  details?: BookingDetails;
  /** Reuse a route already computed (quote conversion) instead of calling Google again. */
  routeOverride?: ParsedRoute;
  /** Admin-agreed final price in cents (revised quote). Recorded in the snapshot. */
  priceOverrideCents?: number;
  quoteRequestId?: string;
}

export type CreateBookingResult =
  | {
      ok: true; id: string; reference: string; totalCents: number | null; currency: string; vehicleName: string; duplicate: boolean; customerId: string;
      region: Region; requiresReview: boolean; roundTrip: boolean; discountCents: number; meetGreetRequested: boolean; meetGreetPending: boolean;
      paymentToken: string | null; payment: { kind: "full" | "deposit"; amountCents: number } | null; childSeatFeeCents: number;
    }
  | { ok: false; status: number; error: string };

const NO_DETAILS: BookingDetails = { bookingFor: "self", passenger: null, luggageCount: null, assistanceNotes: null, pickupInstructions: null, contacts: [], airport: null, policiesAcknowledged: false };

export async function createBooking(db: SupabaseClient, input: CreateBookingInput): Promise<CreateBookingResult> {
  const { trip } = input;
  const details = input.details ?? NO_DETAILS;
  const rt = trip.returnLeg ?? null;

  if (input.submissionKey) {
    const dup = await db.from("bookings").select("id,reference,estimated_fare_cents,currency,customer_id,service_region,requires_manual_review,trip_direction,payment_token,payment_status,child_seat_fee_cents,vehicles(name)").eq("submission_key", input.submissionKey).maybeSingle();
    if (dup.data) {
      const v = dup.data.vehicles as unknown as { name?: string } | null;
      return { ok: true, id: dup.data.id, reference: dup.data.reference, totalCents: dup.data.estimated_fare_cents, currency: dup.data.currency, vehicleName: v?.name ?? "", duplicate: true, customerId: dup.data.customer_id,
        region: (dup.data.service_region ?? "unknown") as Region, requiresReview: Boolean(dup.data.requires_manual_review), roundTrip: dup.data.trip_direction === "round_trip", discountCents: 0, meetGreetRequested: false, meetGreetPending: false,
        paymentToken: dup.data.payment_token ?? null, payment: null, childSeatFeeCents: dup.data.child_seat_fee_cents ?? 0 };
    }
  }

  const fleet = await loadFleet(db);
  const vehicle = fleet.find((v) => v.id === input.vehicleId);
  if (!vehicle) return { ok: false, status: 422, error: "That vehicle is not available. Please choose another." };
  if (vehicle.passengers < trip.passengers) return { ok: false, status: 422, error: "That vehicle does not seat your group. Please choose a larger vehicle." };

  const settings = await loadBookingSettings(db);
  if (details.airport?.meetGreet && !settings.meetGreetEnabled) return { ok: false, status: 422, error: "Airport Meet & Greet is not currently available. Please untick it or contact us." };

  // Server-side routes and fare. The browser's displayed fare is never trusted.
  const avoid = input.routeKey === "no_tolls";
  let route = input.routeOverride ?? null;
  if (!route) {
    const r = await computeRoute(trip, avoid);
    if (!r.ok) {
      // A quote conversion at an agreed price may proceed without a computed route (for example out-of-area trips).
      if (input.priceOverrideCents == null) return { ok: false, status: r.code === "not_configured" ? 503 : r.code === "no_route" ? 422 : 502, error: r.message };
    } else route = r.route;
  }
  let returnRoute: ParsedRoute | null = null;
  if (rt) {
    const rr = await computeRoute({ ...trip, pickup: rt.pickup, dropoff: rt.dropoff, stops: [], pickupAtIso: rt.pickupAtIso }, avoid);
    if (!rr.ok) return { ok: false, status: rr.code === "not_configured" ? 503 : rr.code === "no_route" ? 422 : 502, error: `Return trip: ${rr.message}` };
    returnRoute = rr.route;
  }

  // Extras (Meet & Greet): priced only when an admin has approved a charge. Otherwise it is "pending approval".
  const wantsMG = details.airport?.meetGreet === true;
  const mgApproved = wantsMG && settings.meetGreetChargeCents != null;
  const seatRes = seatExtra(settings.seats, trip.childSeats ?? NO_SEATS, Boolean(rt), trip.passengers);
  if (!seatRes.ok) return { ok: false, status: 422, error: seatRes.error };
  const mgExtras: ExtraLine[] = mgApproved ? [{ code: "meet_greet", label: "Airport Meet & Greet (requested)", cents: settings.meetGreetChargeCents!, detail: "Requested; confirmed by Vanta" }] : [];
  const extras: ExtraLine[] = [...mgExtras, ...(seatRes.line ? [seatRes.line] : [])];

  let totalCents: number | null = null;
  let snapshot: Record<string, unknown> | null = null;
  let lineItems: LineItem[] = [];
  let discountCents = 0;
  let legPricing: { leg: 1 | 2; fare: number | null; snapshot: unknown }[] = [{ leg: 1, fare: null, snapshot: null }];

  if (vehicle.config && route) {
    const outInput: QuoteInput = routeToInput(trip, route, input.routeKey, null) as QuoteInput;
    const promo = await lookupPromo(db, trip.promoCode);
    if (rt && returnRoute) {
      const rules = await loadActiveRoundTripRules(db);
      const rule = pickRule(rules, vehicle.categoryId);
      // Promo codes are not combined with an active round-trip discount (policy pending business approval).
      const disc = rule ? null : promo;
      const retInput: QuoteInput = routeToInput({ ...trip, tripType: "distance", hours: null }, returnRoute, input.routeKey, disc) as QuoteInput;
      const q = calculateRoundTrip(vehicle.config, { ...outInput, discount: disc }, retInput, rule, extras);
      if (!q.ok) return { ok: false, status: 422, error: q.message };
      totalCents = q.totalCents; lineItems = q.lineItems; discountCents = q.discountCents;
      legPricing = q.legs.map((l) => ({ leg: l.leg, fare: l.totalCents, snapshot: { lineItems: l.lineItems, totalCents: l.totalCents, snapshot: l.snapshot } }));
      snapshot = { roundTrip: { rule: q.rule, discountCents: q.discountCents, twoOneWayCents: q.twoOneWayCents, extrasCents: q.extrasCents, legs: legPricing }, route: { distanceMiles: route.distanceMiles, durationMinutes: route.durationMinutes, toll: route.toll } };
    } else {
      const q = calculateQuote(vehicle.config, { ...outInput, discount: promo });
      if (!q.ok) return { ok: false, status: 422, error: q.message };
      const e = withExtras(q, extras);
      totalCents = e.totalCents; lineItems = e.lineItems; discountCents = q.discountCents;
      legPricing = [{ leg: 1, fare: totalCents, snapshot: { lineItems, totalCents } }];
      snapshot = { ...q.snapshot, extras, route: { distanceMiles: route.distanceMiles, durationMinutes: route.durationMinutes, toll: route.toll } };
    }
    if (wantsMG && !mgApproved) snapshot = { ...snapshot, pendingExtras: ["meet_greet_charge_pending_approval"] };
  }
  if (input.priceOverrideCents != null) {
    snapshot = { ...(snapshot ?? {}), override: { priceCents: input.priceOverrideCents, originalTotalCents: totalCents, quoteRequestId: input.quoteRequestId ?? null } };
    totalCents = input.priceOverrideCents;
  }

  const places = [trip.pickup.text, ...trip.stops.map((s) => s.text), trip.dropoff.text, ...(rt ? [rt.pickup.text, rt.dropoff.text] : [])];
  const region = classifyTrip(places);
  const ful = fulfilmentFor(region);
  const policies = await loadPublicPolicies(db);
  const now = new Date().toISOString();

  // Online payment applies only when an admin enabled it, Stripe is configured and the price is known.
  const plan = stripeConfigured() ? paymentPlan(settings.payment, totalCents, 0) : null;
  const customerId = await findOrCreateCustomer(db, input.customer);
  const currency = vehicle.config?.currency ?? "USD";

  const ins = await db.from("bookings").insert({
    customer_id: customerId, vehicle_id: vehicle.id, tier_id: vehicle.tierId, status: "new_request", trip_type: trip.tripType,
    pickup_address: trip.pickup.text, dropoff_address: trip.dropoff.text, pickup_at: trip.pickupAtIso, passengers: trip.passengers,
    hours: trip.hours, distance_miles: route?.distanceMiles ?? null, duration_minutes: route?.durationMinutes ?? null, avoid_tolls: avoid,
    estimated_fare_cents: totalCents, currency, notes: input.notes, submission_key: input.submissionKey, source_quote_request_id: input.quoteRequestId ?? null,
    child_seats: SEAT_TYPES.filter((t) => (trip.childSeats ?? NO_SEATS)[t] > 0).map((t) => ({ type: t, quantity: (trip.childSeats ?? NO_SEATS)[t] })),
    child_seat_fee_cents: input.priceOverrideCents == null ? seatRes.line?.cents ?? 0 : 0, payment_status: plan ? "unpaid" : "not_required",
    trip_direction: rt ? "round_trip" : "one_way", booking_for: details.bookingFor, luggage_count: details.luggageCount,
    assistance_notes: details.assistanceNotes, pickup_instructions: details.pickupInstructions,
    service_region: region, fulfilment_mode: ful.mode, requires_manual_review: ful.requiresManualReview, review_reason: ful.reason,
    policies_acknowledged_at: details.policiesAcknowledged ? now : null,
    policy_snapshot: { waitingIncludedMinutes: settings.waitingIncludedMinutes, waitingIncrementMinutes: settings.waitingIncrementMinutes, waitingRateApproved: settings.waitingRateCents != null, waitingText: policies.waitingText, noShowText: policies.noShowText, assistanceText: policies.assistanceText },
  }).select("id,reference,payment_token").single();

  if (ins.error) {
    if (ins.error.code === "23505" && input.submissionKey) {
      const again = await db.from("bookings").select("id,reference,estimated_fare_cents,currency,customer_id").eq("submission_key", input.submissionKey).maybeSingle();
      if (again.data) return { ok: true, id: again.data.id, reference: again.data.reference, totalCents: again.data.estimated_fare_cents, currency: again.data.currency, vehicleName: vehicle.name, duplicate: true, customerId: again.data.customer_id, region, requiresReview: ful.requiresManualReview, roundTrip: Boolean(rt), discountCents: 0, meetGreetRequested: wantsMG, meetGreetPending: wantsMG && !mgApproved, paymentToken: null, payment: null, childSeatFeeCents: 0 };
    }
    console.error("[booking] insert failed", ins.error.message);
    return { ok: false, status: 500, error: "We could not save your booking. Please try again." };
  }

  // The booking is saved. Related rows are best effort: a failure is logged and never undoes the booking.
  const bookingId = ins.data.id as string;
  const soft = async (label: string, p: PromiseLike<{ error: { message: string } | null }>) => { const r = await p; if (r.error) console.error(`[booking] ${label} insert failed`, r.error.message); };

  if (trip.stops.length) await soft("stops", db.from("booking_stops").insert(trip.stops.map((p, i) => ({ booking_id: bookingId, position: i + 1, address: p.text }))));
  await soft("legs", db.from("booking_legs").insert([
    { booking_id: bookingId, leg_number: 1, direction: "outbound", pickup_address: trip.pickup.text, dropoff_address: trip.dropoff.text, stops: trip.stops.map((s) => s.text), pickup_at: trip.pickupAtIso, distance_miles: route?.distanceMiles ?? null, duration_minutes: route?.durationMinutes ?? null, fare_cents: legPricing[0]?.fare ?? null, pricing_snapshot: legPricing[0]?.snapshot ?? null },
    ...(rt ? [{ booking_id: bookingId, leg_number: 2, direction: "return", pickup_address: rt.pickup.text, dropoff_address: rt.dropoff.text, stops: [], pickup_at: rt.pickupAtIso, distance_miles: returnRoute?.distanceMiles ?? null, duration_minutes: returnRoute?.durationMinutes ?? null, fare_cents: legPricing[1]?.fare ?? null, pricing_snapshot: legPricing[1]?.snapshot ?? null }] : []),
  ]));

  const people: Record<string, unknown>[] = [{ booking_id: bookingId, role: "booker", full_name: input.customer.name, phone: input.customer.phone, email: input.customer.email }];
  if (details.bookingFor === "other" && details.passenger) people.push({ booking_id: bookingId, role: "passenger", full_name: details.passenger.name, phone: details.passenger.phone, email: details.passenger.email });
  for (const c of details.contacts) people.push({ booking_id: bookingId, role: c.type === "secondary" ? "secondary_contact" : "emergency_contact", full_name: c.name, phone: c.phone, relationship: c.relationship });
  await soft("people", db.from("booking_people").insert(people));

  if (details.airport) {
    const a = details.airport;
    await soft("airport", db.from("booking_airport_details").insert({
      booking_id: bookingId, leg_number: 1, airport: a.airport, airline: a.airline, flight_number: a.flightNumber, flight_direction: a.direction, flight_date: a.flightDate, flight_time: a.flightTime,
      terminal: a.terminal, passenger_name: a.passengerName ?? (details.passenger?.name ?? input.customer.name), pickup_instructions: a.pickupInstructions,
      meet_greet_requested: a.meetGreet, meet_greet_status: a.meetGreet ? "requested" : "not_requested", meet_greet_charge_cents: mgApproved ? settings.meetGreetChargeCents : null,
    }));
  }
  if (snapshot && totalCents != null) {
    await soft("snapshot", db.from("pricing_snapshots").insert({ booking_id: bookingId, pricing_config_id: vehicle.config?.id ?? null, snapshot, line_items: lineItems, total_cents: totalCents, currency }));
  }
  await db.from("activity_logs").insert({ action: "booking.created", entity_type: "booking", entity_id: bookingId, meta: { reference: ins.data.reference, source: input.quoteRequestId ? "quote_conversion" : "website", region, roundTrip: Boolean(rt) } });

  return { ok: true, id: bookingId, reference: ins.data.reference, totalCents, currency, vehicleName: vehicle.name, duplicate: false, customerId, region, requiresReview: ful.requiresManualReview, roundTrip: Boolean(rt), discountCents, meetGreetRequested: wantsMG, meetGreetPending: wantsMG && !mgApproved,
    paymentToken: ins.data.payment_token ?? null, payment: plan, childSeatFeeCents: input.priceOverrideCents == null ? seatRes.line?.cents ?? 0 : 0 };
}
