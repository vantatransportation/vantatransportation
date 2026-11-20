import { rushSurcharge } from "@/lib/pricing/surcharge";
import { json, clientIp, readJson, sameOrigin } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getAdminClient } from "@/lib/supabase/admin";
import { computeRoute, mapsConfigured } from "@/lib/geo/google";
import type { ParsedRoute } from "@/lib/geo/parse";
import { validateTrip } from "@/lib/fare/trip";
import { zonedToUtc } from "@/lib/geo/time";
import { BUSINESS_TZ } from "@/lib/config";
import { buildVehicleOptions, loadFleet, lookupPromo, type RouteKey } from "@/lib/fare/service";
import { loadActiveRoundTripRules, loadBookingSettings, seatExtra } from "@/lib/policies";
import { classifyTrip, fulfilmentFor, REGION_LABEL } from "@/lib/coverage";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!rateLimit(`quote:${clientIp(request)}`, 20, 10 * 60_000)) return json({ error: "Too many requests. Please wait a few minutes." }, 429);

  const body = await readJson(request);
  if (!body) return json({ error: "Invalid request." }, 400);
  const parsed = validateTrip(body, new Date(), (d, t) => zonedToUtc(d, t, BUSINESS_TZ));
  if (!parsed.ok) return json({ error: parsed.error }, 422);
  const { trip } = parsed;

  const db = getAdminClient();
  if (!mapsConfigured() || !db) {
    return json({ code: "not_configured", error: "The online fare calculator is not available yet. Please send us your trip details and we will quote you directly." }, 503);
  }

  const fastest = await computeRoute(trip, false);
  if (!fastest.ok) return json({ code: fastest.code, error: fastest.message }, fastest.code === "no_route" ? 422 : 502);

  const routes: Partial<Record<RouteKey, ParsedRoute>> = { fastest: fastest.route };
  // Only look for a no-toll alternative when the fastest route has (or may have) tolls.
  if (fastest.route.toll.status !== "none") {
    const alt = await computeRoute(trip, true);
    if (alt.ok) routes.no_tolls = alt.route;
  }

  // Return journey (round trip): route it the same way, same route preference.
  const returnRoutes: Partial<Record<RouteKey, ParsedRoute>> = {};
  if (trip.returnLeg) {
    const rl = trip.returnLeg;
    const rTrip = { ...trip, pickup: rl.pickup, dropoff: rl.dropoff, stops: [], pickupAtIso: rl.pickupAtIso };
    const rf = await computeRoute(rTrip, false);
    if (!rf.ok) return json({ code: rf.code, error: `Return trip: ${rf.message}` }, rf.code === "no_route" ? 422 : 502);
    returnRoutes.fastest = rf.route;
    if (routes.no_tolls) { const ra = await computeRoute(rTrip, true); if (ra.ok) returnRoutes.no_tolls = ra.route; }
  }

  try {
    const fleet = await loadFleet(db);
    const discount = await lookupPromo(db, trip.promoCode);
    const rtCtx = trip.returnLeg ? { returnRoutes, rules: await loadActiveRoundTripRules(db) } : undefined;
    const settings = await loadBookingSettings(db);
    // Child seats are an add-on charged online, shown separately from the trip estimate.
    const seat = seatExtra(settings.seats, trip.childSeats, Boolean(trip.returnLeg), trip.passengers);
    if (!seat.ok) return json({ error: seat.error }, 422);
    const vehicles = buildVehicleOptions(fleet, trip, routes, discount, rtCtx);
    const tierRows = await db.from("vehicle_tiers").select("id,name,fixed_price_cents,meet_greet_fee_cents,sort_order").eq("is_active", true).order("sort_order");
    const regionKey = classifyTrip([trip.pickup.text, ...trip.stops.map((s) => s.text), trip.dropoff.text, ...(trip.returnLeg ? [trip.returnLeg.pickup.text, trip.returnLeg.dropoff.text] : [])]);
    const routeOptions = (Object.keys(routes) as RouteKey[]).map((key) => {
      const r = routes[key]!;
      return {
        key,
        label: key === "fastest" ? (r.toll.status === "none" ? "Fastest route" : "Fastest route (tolls possible)") : "Route without tolls",
        distanceMiles: r.distanceMiles,
        durationMinutes: r.durationMinutes,
        polyline: r.polyline,
        toll: key === "no_tolls" ? { status: "avoided", amount: 0 } : { status: r.toll.status, amount: r.toll.amount },
      };
    });
    return json({
      routes: routeOptions,
      vehicles,
      promo: trip.promoCode ? { code: trip.promoCode, applied: Boolean(discount), label: discount?.label ?? null } : null,
      pricingAvailable: vehicles.some((v) => v.quotable),
      seatFeeCents: seat.line?.cents ?? 0,
      meetGreetEnabled: settings.meetGreetEnabled,
      // Rush-hour rule for DISPLAY. Whether it applies depends on the pickup time and each route's duration; the server recalculates when booking.
      rush: {
        enabled: settings.rush.enabled, percent: settings.rush.percent,
        applies: Object.fromEntries((Object.keys(routes) as RouteKey[]).map((k) => [k, rushSurcharge(1, [
          { startIso: trip.pickupAtIso, durationMinutes: routes[k]!.durationMinutes },
          ...(trip.returnLeg ? [{ startIso: trip.returnLeg.pickupAtIso, durationMinutes: returnRoutes[k]?.durationMinutes ?? null }] : []),
        ], { ...settings.rush, percent: Math.max(settings.rush.percent, 1) }).applies])),
      },
      tiers: (tierRows.data ?? []).map((t: Record<string, any>) => ({ name: t.name, fixedPriceCents: t.fixed_price_cents ?? null, meetGreetFeeCents: t.meet_greet_fee_cents ?? null })), // eslint-disable-line @typescript-eslint/no-explicit-any
      seatInfo: { oneWayCents: settings.seats.oneWayCents, roundTripCents: settings.seats.roundTripCents, max: settings.seats.max },
      region: { key: regionKey, label: REGION_LABEL[regionKey], manualReview: fulfilmentFor(regionKey).requiresManualReview },
    });
  } catch (e) {
    console.error("[fare] failed to build options", e);
    return json({ error: "We could not load vehicle pricing. Please try again." }, 500);
  }
}
