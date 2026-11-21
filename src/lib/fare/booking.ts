import { generateTrackingCode } from "@/lib/tracking";
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
import { availableProviders } from "@/lib/payment-providers";
import { onlineCharge, CHARGE_REASON_TEXT, type OnlineCharge } from "@/lib/tier-pricing";
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
      trackingCode: string | null; paymentToken: string | null; payment: { kind: "full" | "deposit"; amountCents: number } | null; childSeatFeeCents: number;
      /** What is charged online: fixed tier price + Meet & Greet + child seats. null when the tier price is not configured. */
      online: OnlineCharge | null;
    }
  | { ok: false; status: number; error: string };

const NO_DETAILS: BookingDetails = { bookingFor: "self", passenger: null, luggageCount: null, assistanceNotes: null, pickupInstructions: null, contacts: [], airport: null, policiesAcknowledged: false };

export async function createBooking(db: SupabaseClient, input: CreateBookingInput): Promise<CreateBookingResult> {
  const { trip } = input;
  const details = input.details ?? NO_DETAILS;
  const rt = trip.returnLeg ?? null;

  if (input.submissionKey) {
    const dup = await db.from("bookings").select("id,reference,tracking_code,estimated_fare_cents,currency,customer_id,service_region,requires_manual_review,trip_direction,payment_token,payment_status,child_seat_fee_cents,vehicles(name)").eq("submission_key", input.submissionKey).maybeSingle();
    if (dup.data) {
      const v = dup.data.vehicles as unknown as { name?: string } | null;
      return { ok: true, id: dup.data.id, reference: dup.data.reference, totalCents: dup.data.estimated_fare_cents, currency: dup.data.currency, vehicleName: v?.name ?? "", duplicate: true, customerId: dup.data.customer_id,
        region: (dup.data.service_region ?? "unknown") as Region, requiresReview: Boolean(dup.data.requires_manual_review), roundTrip: dup.data.trip_direction === "round_trip", discountCents: 0, meetGreetRequested: false, meetGreetPending: false,
        trackingCode: dup.data.tracking_code ?? null, paymentToken: dup.data.payment_token ?? null, payment: null, childSeatFeeCents: dup.data.child_seat_fee_cents ?? 0, online: null };
    }
  }

  const fleet = await loadFleet(db);
  const vehicle = fleet.find((v) => v.id === input.vehicleId);
  if (!vehicle) return { ok: false, status: 422, error: "That vehicle is not available. Please choose another." };
  if (vehicle.passengers < trip.passengers) return { ok: false, status: 422, error: "That vehicle does not seat your group. Please choose a larger vehicle." };

  const settings = await loadBookingSettings(db);
  if (trip.meetGreet && !settings.meetGreetEnabled) return { ok: false, status: 422, error: "Airport Meet & Greet is not currently available. Please untick it or contact us." };
  if (input.details && trip.meetGreet && !details.airport?.airport) return { ok: false, status: 422, error: "Enter the airport and flight details for your Meet & Greet." };

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

  // Add-ons charged ONLINE: Meet & Greet (the selected tier's fee) and child seats. They are NOT part of the trip estimate.
  const wantsMG = trip.meetGreet === true;
  const seatRes = seatExtra(settings.seats, trip.childSeats ?? NO_SEATS, Boolean(rt), trip.passengers);
  if (!seatRes.ok) return { ok: false, status: 422, error: seatRes.error };
  const seatCents = seatRes.line?.cents ?? 0;
  // The online charge is calculated here, from the database, whatever the browser displayed. Quote conversions at an
  // agreed price carry no online charge.
  const chargeRes = input.priceOverrideCents != null ? null : onlineCharge(vehicle.tierPricing, { meetGreet: wantsMG, addonsCents: seatCents });
  if (chargeRes && !chargeRes.ok && wantsMG && (chargeRes.reason === "meet_greet_unavailable" || chargeRes.reason === "tier_missing")) {
    return { ok: false, status: 422, error: `${CHARGE_REASON_TEXT[chargeRes.reason]} Please untick Meet & Greet or contact us.` };
  }
  const online: OnlineCharge | null = chargeRes && chargeRes.ok ? chargeRes.charge : null;
  const extras: ExtraLine[] = []; // the trip estimate carries no add-ons

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
  const plan = availableProviders(settings).length > 0 ? paymentPlan(settings.payment, online?.totalCents ?? null, 0) : null;
  snapshot = { ...(snapshot ?? {}), online };
  const customerId = await findOrCreateCustomer(db, input.customer);
  const currency = vehicle.config?.currency ?? "USD";

  const ins = await db.from("bookings").insert({
    tracking_code: generateTrackingCode(), // unguessable credential for the public Track page; the sequential reference is NOT one
    customer_id: customerId, vehicle_id: vehicle.id, tier_id: vehicle.tierId, status: "new_request", trip_type: trip.tripType,
    pickup_address: trip.pickup.text, dropoff_address: trip.dropoff.text, pickup_at: trip.pickupAtIso, passengers: trip.passengers,
    hours: trip.hours, distance_miles: route?.distanceMiles ?? null, duration_minutes: route?.durationMinutes ?? null, avoid_tolls: avoid,
    estimated_fare_cents: totalCents, currency, notes: input.notes, submission_key: input.submissionKey, source_quote_request_id: input.quoteRequestId ?? null,
    child_seats: SEAT_TYPES.filter((t) => (trip.childSeats ?? NO_SEATS)[t] > 0).map((t) => ({ type: t, quantity: (trip.childSeats ?? NO_SEATS)[t] })),
    child_seat_fee_cents: seatCents, tier_name: vehicle.tier || null, fixed_price_cents: online?.fixedPriceCents ?? null,
    meet_greet_selected: wantsMG, meet_greet_fee_cents: online && wantsMG ? online.meetGreetCents : null, online_amount_cents: online?.totalCents ?? null, payment_status: plan ? "unpaid" : "not_required",
    trip_direction: rt ? "round_trip" : "one_way", booking_for: details.bookingFor, luggage_count: details.luggageCount,
    assistance_notes: details.assistanceNotes, pickup_instructions: details.pickupInstructions,
    service_region: region, fulfilment_mode: ful.mode, requires_manual_review: ful.requiresManualReview, review_reason: ful.reason,
    policies_acknowledged_at: details.policiesAcknowledged ? now : null,
    policy_snapshot: { waitingIncludedMinutes: settings.waitingIncludedMinutes, waitingIncrementMinutes: settings.waitingIncrementMinutes, waitingRateApproved: settings.waitingRateCents != null, waitingText: policies.waitingText, noShowText: policies.noShowText, assistanceText: policies.assistanceText },
  }).select("id,reference,payment_token,tracking_code").single();

  if (ins.error) {
    if (ins.error.code === "23505" && input.submissionKey) {
      const again = await db.from("bookings").select("id,reference,tracking_code,estimated_fare_cents,currency,customer_id").eq("submission_key", input.submissionKey).maybeSingle();
      if (again.data) return { ok: true, id: again.data.id, reference: again.data.reference, totalCents: again.data.estimated_fare_cents, currency: again.data.currency, vehicleName: vehicle.name, duplicate: true, customerId: again.data.customer_id, region, requiresReview: ful.requiresManualReview, roundTrip: Boolean(rt), discountCents: 0, meetGreetRequested: wantsMG, meetGreetPending: false, trackingCode: again.data.tracking_code ?? null, paymentToken: null, payment: null, childSeatFeeCents: 0, online: null };
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
      meet_greet_requested: wantsMG, meet_greet_status: wantsMG ? "requested" : "not_requested", meet_greet_charge_cents: online && wantsMG ? online.meetGreetCents : null,
    }));
  }
  if (snapshot && totalCents != null) {
    await soft("snapshot", db.from("pricing_snapshots").insert({ booking_id: bookingId, pricing_config_id: vehicle.config?.id ?? null, snapshot, line_items: lineItems, total_cents: totalCents, currency }));
  }
  await db.from("activity_logs").insert({ action: "booking.created", entity_type: "booking", entity_id: bookingId, meta: { reference: ins.data.reference, source: input.quoteRequestId ? "quote_conversion" : "website", region, roundTrip: Boolean(rt) } });

  return { ok: true, id: bookingId, reference: ins.data.reference, totalCents, currency, vehicleName: vehicle.name, duplicate: false, customerId, region, requiresReview: ful.requiresManualReview, roundTrip: Boolean(rt), discountCents, meetGreetRequested: wantsMG, meetGreetPending: false,
    trackingCode: ins.data.tracking_code ?? null, paymentToken: ins.data.payment_token ?? null, payment: plan, childSeatFeeCents: seatCents, online };
}
