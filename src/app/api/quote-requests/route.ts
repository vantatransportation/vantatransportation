import { json, clientIp, readJson, sameOrigin } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getAdminClient } from "@/lib/supabase/admin";
import { validateTrip } from "@/lib/fare/trip";
import { zonedToUtc, formatPickup } from "@/lib/geo/time";
import { BUSINESS_TZ } from "@/lib/config";
import { computeRoute } from "@/lib/geo/google";
import { loadFleet, lookupPromo, routeToInput } from "@/lib/fare/service";
import { resolveTierChoice } from "@/lib/vehicle-tiers";
import { calculateQuote, formatMoney } from "@/lib/pricing/engine";
import { calculateRoundTrip, withExtras } from "@/lib/pricing/roundtrip";
import { loadActiveRoundTripRules, loadBookingSettings, pickRule, seatExtra } from "@/lib/policies";
import { findOrCreateCustomer } from "@/lib/customers";
import { notify } from "@/lib/notify";
import { clean, EMAIL_RE, phoneDigits } from "@/lib/validation";
import { combinedTripFareCents } from "@/lib/tier-pricing";
import { classifyTrip, fulfilmentFor, REGION_LABEL } from "@/lib/coverage";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!rateLimit(`qr:${clientIp(request)}`, 5, 10 * 60_000)) return json({ error: "Too many requests. Please wait a few minutes." }, 429);

  const body = await readJson(request);
  if (!body) return json({ error: "Invalid request." }, 400);
  if (typeof body.website === "string" && body.website) return json({ ok: true });

  const name = clean(body.name, 120);
  const email = clean(body.email, 200).toLowerCase();
  const phone = clean(body.phone, 30);
  const message = clean(body.message, 3000) || null;
  const routeKey = body.routeKey === "no_tolls" ? "no_tolls" : "fastest";
  const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId : "";
  const requestedTierId = typeof body.tierId === "string" && body.tierId ? body.tierId : null;
  const submissionKey = typeof body.submissionKey === "string" && /^[\w-]{16,80}$/.test(body.submissionKey) ? body.submissionKey : null;
  const budgetDollars = body.desiredBudget === "" || body.desiredBudget == null ? null : Number(body.desiredBudget);

  const fields: Record<string, string> = {};
  if (name.length < 2) fields.name = "Enter your name.";
  if (!EMAIL_RE.test(email)) fields.email = "Enter a valid email address.";
  if (phoneDigits(phone).length < 10) fields.phone = "Enter a valid phone number.";
  if (budgetDollars != null && (!Number.isFinite(budgetDollars) || budgetDollars < 0 || budgetDollars > 100000)) fields.desiredBudget = "Enter a valid amount.";
  if (Object.keys(fields).length) return json({ error: "Check the highlighted fields.", fields }, 422);

  const parsed = validateTrip(body.trip, new Date(), (d, t) => zonedToUtc(d, t, BUSINESS_TZ));
  if (!parsed.ok) return json({ error: parsed.error }, 422);
  const trip = parsed.trip;

  const db = getAdminClient();
  if (!db) return json({ error: "Quote requests are temporarily unavailable. Please contact us directly." }, 503);

  try {
    if (submissionKey) {
      const dup = await db.from("quote_requests").select("id").eq("submission_key", submissionKey).maybeSingle();
      if (dup.data) return json({ ok: true });
    }

    // Recompute the original quote on the server; never trust a browser-supplied price.
    // A route or price is optional: out-of-area or unroutable trips are still saved for manual review.
    const fleet = await loadFleet(db);
    const vehicle = fleet.find((v) => v.id === vehicleId) ?? null;
    // A tier sent with the request must be one of the vehicle's tiers. It is saved with the request so a later booking keeps it.
    // (A request without a tier is still accepted: staff pick the tier when converting it.)
    let tierId: string | null = null;
    if (vehicle && requestedTierId) {
      const choice = resolveTierChoice(vehicle.tiers, requestedTierId);
      if (!choice.ok) return json({ error: choice.error }, 422);
      tierId = choice.tier?.id ?? null;
    }
    const routeRes = vehicle ? await computeRoute(trip, routeKey === "no_tolls") : null;
    const route = routeRes && routeRes.ok ? routeRes.route : null;

    const seat = seatExtra((await loadBookingSettings(db)).seats, trip.childSeats, Boolean(trip.returnLeg), trip.passengers);
    if (!seat.ok) return json({ error: seat.error }, 422);
    const extras: never[] = []; // the saved estimate is the trip-based estimate only; add-ons are priced separately
    let originalCents: number | null = null;
    let snapshot: Record<string, unknown> | null = null;
    let lineItems: unknown = [];
    if (vehicle?.config && route) {
      const rl = trip.returnLeg;
      const retRes = rl ? await computeRoute({ ...trip, pickup: rl.pickup, dropoff: rl.dropoff, stops: [], pickupAtIso: rl.pickupAtIso }, routeKey === "no_tolls") : null;
      if (rl && retRes?.ok) {
        // Round trip: keep the original estimate for BOTH legs, as the customer saw it.
        const rule = pickRule(await loadActiveRoundTripRules(db), vehicle.categoryId);
        const rq = calculateRoundTrip(vehicle.config, routeToInput(trip, route, routeKey, null), routeToInput({ ...trip, tripType: "distance", hours: null }, retRes.route, routeKey, null), rule, extras);
        if (rq.ok) { originalCents = rq.totalCents; lineItems = rq.lineItems; snapshot = { roundTrip: { rule: rq.rule, discountCents: rq.discountCents, twoOneWayCents: rq.twoOneWayCents } }; }
      } else if (!rl) {
        const q = calculateQuote(vehicle.config, routeToInput(trip, route, routeKey, await lookupPromo(db, trip.promoCode)));
        if (q.ok) { const e = withExtras(q, extras); originalCents = e.totalCents; snapshot = { ...q.snapshot }; lineItems = e.lineItems; }
      }
    }
    // The "original quote" is what the customer was shown as the combined Trip fare: the selected tier's fixed fee + the server-calculated trip estimate.
    // The internal split is kept in the snapshot for admins only. Without a configured tier fee the plain estimate is kept (as before).
    const tierFee = tierId ? vehicle?.tiers.find((t) => t.id === tierId)?.fixedPriceCents ?? null : null;
    if (originalCents != null && tierFee != null) {
      snapshot = { ...(snapshot ?? {}), originalQuote: { tripEstimateCents: originalCents, tierFixedPriceCents: tierFee, tripFareCents: combinedTripFareCents(tierFee, originalCents) } };
      originalCents = combinedTripFareCents(tierFee, originalCents);
    }
    const region = classifyTrip([trip.pickup.text, ...trip.stops.map((s) => s.text), trip.dropoff.text]);

    const customerId = await findOrCreateCustomer(db, { name, email, phone });
    const ins = await db.from("quote_requests").insert({
      customer_id: customerId, name, email, phone, vehicle_id: vehicle?.id ?? null, original_quote_cents: originalCents,
      trip: { trip, routeKey, tierId, route: route ? { distanceMiles: route.distanceMiles, durationMinutes: route.durationMinutes, toll: route.toll } : null },
      source: vehicle ? "calculator" : "manual", service_region: region,
      desired_budget_cents: budgetDollars != null ? Math.round(budgetDollars * 100) : null, message, submission_key: submissionKey,
    }).select("id").single();
    if (ins.error) {
      console.error("[quote-requests] insert failed", ins.error);
      return json({ error: "We could not save your request. Please try again." }, 500);
    }
    if (snapshot && originalCents != null) {
      await db.from("pricing_snapshots").insert({ quote_request_id: ins.data.id, pricing_config_id: vehicle?.config?.id ?? null, snapshot, line_items: lineItems, total_cents: originalCents, currency: vehicle?.config?.currency ?? "USD" });
    }
    await db.from("activity_logs").insert({ action: "quote.created", entity_type: "quote_request", entity_id: ins.data.id, meta: {} });

    await notify(db, "quote.created", { type: "quote_request", id: ins.data.id }, {
      Customer: name, Email: email, Phone: phone, Vehicle: vehicle?.name ?? "Not selected", Pickup: trip.pickup.text, Destination: trip.dropoff.text, "Service region": REGION_LABEL[region] + (fulfilmentFor(region).requiresManualReview ? " (staff review)" : ""),
      When: formatPickup(trip.pickupAtIso, BUSINESS_TZ), "Original quote": originalCents != null ? formatMoney(originalCents) : "n/a",
      "Desired budget": budgetDollars != null ? formatMoney(Math.round(budgetDollars * 100)) : undefined, Message: message ?? undefined,
    });
    return json({ ok: true });
  } catch (e) {
    console.error("[quote-requests] unexpected error", e);
    return json({ error: "We could not save your request. Please try again." }, 500);
  }
}
