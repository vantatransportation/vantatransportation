import { json, clientIp, readJson, sameOrigin } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getAdminClient } from "@/lib/supabase/admin";
import { validateTrip } from "@/lib/fare/trip";
import { zonedToUtc, formatPickup } from "@/lib/geo/time";
import { BUSINESS_TZ } from "@/lib/config";
import { createBooking } from "@/lib/fare/booking";
import { notify } from "@/lib/notify";
import { clean, EMAIL_RE, phoneDigits } from "@/lib/validation";
import { formatMoney } from "@/lib/pricing/engine";
import { validateBookingDetails } from "@/lib/booking-details";
import { REGION_LABEL } from "@/lib/coverage";
import { childSeatSummary, NO_SEATS } from "@/lib/child-seats";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!rateLimit(`book:${clientIp(request)}`, 6, 10 * 60_000)) return json({ error: "Too many requests. Please wait a few minutes." }, 429);

  const body = await readJson(request);
  if (!body) return json({ error: "Invalid request." }, 400);
  if (typeof body.website === "string" && body.website) return json({ ok: true, reference: "VT-0000" }); // honeypot

  const name = clean(body.name, 120);
  const email = clean(body.email, 200).toLowerCase();
  const phone = clean(body.phone, 30);
  const notes = clean(body.notes, 2000) || null;
  const submissionKey = typeof body.submissionKey === "string" && /^[\w-]{16,80}$/.test(body.submissionKey) ? body.submissionKey : null;
  const routeKey = body.routeKey === "no_tolls" ? "no_tolls" : "fastest";
  const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId : "";

  const fields: Record<string, string> = {};
  if (name.length < 2) fields.name = "Enter your full name.";
  if (!EMAIL_RE.test(email)) fields.email = "Enter a valid email address.";
  if (phoneDigits(phone).length < 10) fields.phone = "Enter a valid phone number.";
  if (Object.keys(fields).length) return json({ error: "Check the highlighted fields.", fields }, 422);

  const det = validateBookingDetails(body);
  if (!det.ok) return json({ error: det.error, fields: det.fields }, 422);

  const parsed = validateTrip(body.trip, new Date(), (d, t) => zonedToUtc(d, t, BUSINESS_TZ));
  if (!parsed.ok) return json({ error: parsed.error }, 422);

  const db = getAdminClient();
  if (!db) return json({ error: "Booking is temporarily unavailable. Please contact us directly." }, 503);

  try {
    const result = await createBooking(db, { trip: parsed.trip, vehicleId, routeKey, customer: { name, email, phone }, notes, submissionKey, details: det.details });
    if (!result.ok) return json({ error: result.error }, result.status);

    // The booking is already saved. Notifications can fail without affecting it.
    if (!result.duplicate) {
      const t = parsed.trip;
      const seatText = childSeatSummary(t.childSeats ?? NO_SEATS);
      const site = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/$/, "");
      // No payment link is created or sent at submission: payment is released only after an admin approves the booking.
      const trackUrl = result.trackingCode && site ? `${site}/track#id=${result.trackingCode}` : undefined;
      const extrasText = [t.returnLeg ? "Round trip" : "", seatText ? `Child seats: ${seatText} (requested)` : "", result.meetGreetRequested ? "Meet & Greet requested" : ""].filter(Boolean).join(", ");
      // Alerts intentionally omit phone numbers, notes, passenger instructions and emergency contacts.
      await notify(db, "booking.created", { type: "booking", id: result.id }, {
        Reference: result.reference, Customer: name, Email: email, Pickup: t.pickup.text,
        Stops: t.stops.map((s) => s.text).join(" | ") || undefined, Destination: t.dropoff.text,
        When: formatPickup(t.pickupAtIso, BUSINESS_TZ) + (t.returnLeg ? `  (return ${formatPickup(t.returnLeg.pickupAtIso, BUSINESS_TZ)})` : ""), Passengers: String(t.passengers), Vehicle: result.vehicleName,
        "Trip type": t.tripType === "hourly" ? `Hourly (${t.hours} h)` : t.returnLeg ? "Round trip" : "Point to point",
        "Estimated trip fare (information only)": result.totalCents != null ? formatMoney(result.totalCents, result.currency) : "To be confirmed",
        Tier: result.online?.tierName, "Fixed tier price": result.online ? formatMoney(result.online.fixedPriceCents, result.currency) : undefined,
        "Meet & Greet": result.online && result.online.meetGreetCents > 0 ? formatMoney(result.online.meetGreetCents, result.currency) : result.meetGreetRequested ? "Requested" : undefined,
        "Child car seats": result.childSeatFeeCents > 0 ? formatMoney(result.childSeatFeeCents, result.currency) : undefined,
        "Online amount due": result.online ? formatMoney(result.online.totalCents, result.currency) : "Not set up yet",
        "Service region": REGION_LABEL[result.region], "Needs staff review": result.requiresReview ? "Yes" : undefined,
        "Requested extras": extrasText || undefined, "Booking for": det.details.bookingFor === "other" ? "Someone else" : undefined,
        _customerEmail: email, _customerName: name, _trackingId: result.trackingCode ?? undefined, _trackUrl: trackUrl,
      });
    }
    return json({ ok: true, reference: result.reference, totalCents: result.totalCents, onlineAmountCents: result.online?.totalCents ?? null, currency: result.currency, trackingId: result.trackingCode, payUrl: null });
  } catch (e) {
    console.error("[bookings] unexpected error", e);
    return json({ error: "We could not save your booking. Please try again." }, 500);
  }
}
