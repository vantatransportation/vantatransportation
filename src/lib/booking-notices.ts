import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notify } from "@/lib/notify";
import { trackingUrl } from "@/lib/tracking-url";
import { formatMoney } from "@/lib/pricing/engine";
import { formatPickup } from "@/lib/geo/time";
import { BUSINESS_TZ } from "@/lib/config";
import { customerPricing } from "@/lib/tier-pricing";
import { REGION_LABEL, type Region } from "@/lib/coverage";
import { childSeatSummary, NO_SEATS, SEAT_TYPES, type ChildSeats } from "@/lib/child-seats";

/**
 * The "booking request received" notice (business alert + customer email), built from the SAVED booking.
 *
 * With the saved-card workflow a request is complete only once the customer's card is saved (Stripe confirmed it), so the notice is sent at that
 * moment instead of when the form is submitted: the business never sees a half-finished request, and the customer is never told "request received"
 * for something that is not yet with the business. Duplicate deliveries are suppressed by the notification dedupe key.
 * Alerts intentionally omit phone numbers, notes, passenger instructions and emergency contacts.
 */
export async function sendBookingCreatedNotice(db: SupabaseClient, bookingId: string): Promise<void> {
  const { data: b } = await db.from("bookings").select("id,reference,tracking_code,pickup_at,pickup_address,dropoff_address,passengers,trip_type,hours,trip_direction,tier_name,fixed_price_cents,estimated_fare_cents,online_amount_cents,meet_greet_selected,meet_greet_fee_cents,child_seats,child_seat_fee_cents,currency,service_region,requires_manual_review,booking_for,customer_id,card_brand,card_last4,vehicles(name)").eq("id", bookingId).maybeSingle();
  if (!b) return;
  const [cust, stops, legs] = await Promise.all([
    db.from("customers").select("name,email").eq("id", b.customer_id).maybeSingle(),
    db.from("booking_stops").select("position,address").eq("booking_id", b.id).order("position"),
    db.from("booking_legs").select("leg_number,pickup_at").eq("booking_id", b.id).order("leg_number"),
  ]);
  const currency = String(b.currency ?? "USD");
  const seats: ChildSeats = { ...NO_SEATS };
  for (const s of (Array.isArray(b.child_seats) ? b.child_seats : []) as { type: string; quantity: number }[]) if ((SEAT_TYPES as readonly string[]).includes(s.type)) seats[s.type as keyof ChildSeats] = Number(s.quantity) || 0;
  const seatText = childSeatSummary(seats);
  const cp = b.online_amount_cents != null ? customerPricing(b.online_amount_cents, b.meet_greet_selected ? b.meet_greet_fee_cents : 0, b.child_seat_fee_cents) : null;
  const ret = (legs.data ?? []).find((l: { leg_number: number }) => l.leg_number === 2) as { pickup_at: string } | undefined;
  const roundTrip = b.trip_direction === "round_trip";
  const veh = b.vehicles as unknown as { name?: string } | null;
  const extras = [roundTrip ? "Round trip" : "", seatText ? `Child seats: ${seatText} (requested)` : "", b.meet_greet_selected ? "Meet & Greet requested" : ""].filter(Boolean).join(", ");
  const card = b.card_last4 ? `${String(b.card_brand ?? "card").toUpperCase()} ending ${b.card_last4}: saved, nothing charged, no funds held` : undefined;
  await notify(db, "booking.created", { type: "booking", id: b.id }, {
    Reference: b.reference, Customer: cust.data?.name ?? undefined, Email: cust.data?.email ?? undefined, Pickup: b.pickup_address,
    Stops: (stops.data ?? []).map((s: { address: string }) => s.address).join(" | ") || undefined, Destination: b.dropoff_address ?? undefined,
    When: b.pickup_at ? formatPickup(b.pickup_at, BUSINESS_TZ) + (ret ? `  (return ${formatPickup(ret.pickup_at, BUSINESS_TZ)})` : "") : undefined,
    Passengers: String(b.passengers), Vehicle: veh?.name,
    "Trip type": b.trip_type === "hourly" ? `Hourly (${b.hours} h)` : roundTrip ? "Round trip" : "Point to point",
    // Customer-facing fields (the customer email uses ONLY these): one combined Trip fare, optional services, Total.
    "Trip fare": cp ? formatMoney(cp.tripFareCents, currency) : "To be confirmed",
    "Meet & Greet": cp && cp.meetGreetCents > 0 ? formatMoney(cp.meetGreetCents, currency) : b.meet_greet_selected ? "Requested" : undefined,
    "Child car seats": cp && cp.childSeatCents > 0 ? formatMoney(cp.childSeatCents, currency) : undefined,
    Total: cp ? formatMoney(cp.totalCents, currency) : undefined,
    // Internal fields (business email only; see templates.ts).
    Tier: b.tier_name ?? undefined, "Fixed tier price (internal)": b.fixed_price_cents != null ? formatMoney(b.fixed_price_cents, currency) : undefined,
    "Trip estimate (internal)": b.online_amount_cents != null && b.fixed_price_cents != null ? formatMoney(b.online_amount_cents - b.fixed_price_cents - (b.meet_greet_selected ? b.meet_greet_fee_cents ?? 0 : 0) - (b.child_seat_fee_cents ?? 0), currency) : b.estimated_fare_cents != null ? formatMoney(b.estimated_fare_cents, currency) : undefined,
    "Service region": REGION_LABEL[(b.service_region ?? "unknown") as Region], "Needs staff review": b.requires_manual_review ? "Yes" : undefined,
    "Requested extras": extras || undefined, "Booking for": b.booking_for === "other" ? "Someone else" : undefined, "Card on file": card,
    _customerEmail: cust.data?.email ?? undefined, _customerName: cust.data?.name ?? undefined, _trackingId: b.tracking_code ?? undefined, _trackUrl: trackingUrl(b.tracking_code) ?? undefined,
  });
}
