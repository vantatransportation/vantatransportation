import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateQuote, type DiscountInput, type LineItem, type PricingConfig, type QuoteResult } from "@/lib/pricing/engine";
import { calculateRoundTrip, withExtras, type ExtraLine } from "@/lib/pricing/roundtrip";
import { pickRule, type RuleRow } from "@/lib/policies";
import type { ParsedRoute } from "@/lib/geo/parse";
import type { Trip } from "./trip";
import { resolvePhotoSrc } from "@/lib/vehicle-photo";
import { loadVehicleTiers, type TierRow } from "@/lib/vehicle-tiers";

export type RouteKey = "fastest" | "no_tolls";

export interface FleetVehicle {
  id: string;
  name: string;
  category: string;
  categoryId: string | null;
  /**
   * Every ACTIVE service tier this vehicle is offered in (from vehicle_tier_assignments), in tier order, each with its own
   * admin-configured fixed price and Meet & Greet fee (null = not set). The vehicle is ONE record whatever the number of tiers.
   * The trip estimate (`config`) belongs to the vehicle; the online charge belongs to the tier the customer picks.
   */
  tiers: TierRow[];
  passengers: number;
  /** Real photo URL, or null when none is assigned (the site then shows a branded placeholder). */
  image: string | null;
  imagePublicId: string | null;
  description: string;
  capacityLabel: string;
  similarModels: string;
  config: PricingConfig | null; // null = pricing not published
}

/** Loads bookable vehicles with their ACTIVE pricing only. Draft/archived pricing is never used. */
export async function loadFleet(db: SupabaseClient): Promise<FleetVehicle[]> {
  const { data, error } = await db
    .from("vehicles")
    .select("id,name,description,passenger_capacity,image_url,image_public_id,similar_models,tier_id, vehicle_categories(id,name,capacity_label,sort_order), pricing_configs(*, pricing_surcharges(*))")
    .eq("is_active", true)
    .eq("is_available", true)
    .order("sort_order");
  if (error) throw error;
  // Tiers come from the join table (never embedded: with the legacy FK AND the join table PostgREST cannot resolve the embed).
  const { byVehicle } = await loadVehicleTiers(db, (data ?? []) as { id: string; tier_id?: string | null }[]);

  return (data ?? []).map((v: Record<string, any>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const active = (v.pricing_configs ?? []).find((c: Record<string, any>) => c.status === "active"); // eslint-disable-line @typescript-eslint/no-explicit-any
    const config: PricingConfig | null = active
      ? {
          id: active.id, vehicleId: v.id, status: "active", currency: active.currency || "USD",
          perMile: Number(active.per_mile), hourlyRate: active.hourly_rate == null ? null : Number(active.hourly_rate),
          minimumFare: Number(active.minimum_fare), baseFare: Number(active.base_fare),
          hourlyIncludedMiles: Number(active.hourly_included_miles), hourlyIncludedScope: active.hourly_included_scope,
          hourlyExtraMileRate: Number(active.hourly_extra_mile_rate), minHours: Number(active.min_hours),
          longTripThresholdMiles: active.long_trip_threshold_miles == null ? null : Number(active.long_trip_threshold_miles),
          longTripPerMile: active.long_trip_per_mile == null ? null : Number(active.long_trip_per_mile),
          surcharges: (active.pricing_surcharges ?? [])
            .filter((s: Record<string, any>) => s.is_active) // eslint-disable-line @typescript-eslint/no-explicit-any
            .map((s: Record<string, any>) => ({ id: s.id, label: s.label, kind: s.kind, amount: Number(s.amount) })), // eslint-disable-line @typescript-eslint/no-explicit-any
        }
      : null;
    return {
      id: v.id, name: v.name, category: v.vehicle_categories?.name ?? "", categoryId: v.vehicle_categories?.id ?? null,
      tiers: byVehicle.get(v.id) ?? [],
      passengers: v.passenger_capacity, image: resolvePhotoSrc(v.image_url), imagePublicId: v.image_public_id ?? null,
      description: v.description ?? "", capacityLabel: v.vehicle_categories?.capacity_label ?? "", similarModels: v.similar_models ?? "", config,
    };
  });
}

/** Looks up an admin-created promo code. Admin-created codes count as approved. */
export async function lookupPromo(db: SupabaseClient, code: string | null): Promise<DiscountInput | null> {
  if (!code) return null;
  const { data } = await db.from("discounts").select("label,kind,amount,starts_at,ends_at").ilike("code", code).eq("is_active", true).maybeSingle();
  if (!data) return null;
  const now = Date.now();
  if (data.starts_at && new Date(data.starts_at).getTime() > now) return null;
  if (data.ends_at && new Date(data.ends_at).getTime() < now) return null;
  return { label: data.label, kind: data.kind, amount: Number(data.amount), approved: true };
}

export function routeToInput(trip: Trip, route: ParsedRoute, key: RouteKey, discount: DiscountInput | null) {
  return {
    tripType: trip.tripType,
    distanceMiles: route.distanceMiles,
    hours: trip.hours ?? undefined,
    durationMinutes: route.durationMinutes,
    avoidTolls: key === "no_tolls",
    tollAmount: route.toll.status === "known" ? route.toll.amount : route.toll.status === "none" ? 0 : null,
    discount,
  } as const;
}

export interface PublicQuote {
  totalCents: number;
  currency: string;
  lineItems: LineItem[];
  tollStatus: "included" | "unavailable" | "avoided";
  minimumApplied: boolean;
  /** Present for round trips: both legs, any discount, and what two separate one-way trips would cost. */
  roundTrip?: { discountCents: number; twoOneWayCents: number; ruleLabel: string | null; legs: { label: string; totalCents: number }[] };
}

export const toPublicQuote = (q: Extract<QuoteResult, { ok: true }>, extras: ExtraLine[] = []): PublicQuote => {
  const e = withExtras(q, extras);
  return { totalCents: e.totalCents, currency: q.currency, lineItems: e.lineItems, tollStatus: q.toll.status, minimumApplied: q.minimumApplied };
};

export interface VehicleOption {
  id: string; name: string; category: string; passengers: number; image: string | null; similarModels: string;
  description: string; capacityLabel: string;
  /** The tiers this vehicle is offered in, each with its fixed price and Meet & Greet fee (display copy; the server recalculates). */
  tiers: { id: string; name: string; fixedPriceCents: number | null; meetGreetFeeCents: number | null }[];
  quotable: boolean;
  quotes: Partial<Record<RouteKey, PublicQuote>>;
}

/** Builds per-vehicle options for every available route. Only vehicles that fit the group are returned. */
export interface RoundTripContext { returnRoutes: Partial<Record<RouteKey, ParsedRoute>>; rules: RuleRow[] }

export function buildVehicleOptions(fleet: FleetVehicle[], trip: Trip, routes: Partial<Record<RouteKey, ParsedRoute>>, discount: DiscountInput | null, rt?: RoundTripContext, extras: ExtraLine[] = []): VehicleOption[] {
  const out: VehicleOption[] = [];
  for (const v of fleet) {
    if (v.passengers < trip.passengers) continue;
    if (v.tiers.length === 0) continue; // a vehicle offered in no tier is not offered online (the admin list flags it)
    const quotes: VehicleOption["quotes"] = {};
    if (v.config) {
      for (const key of ["fastest", "no_tolls"] as RouteKey[]) {
        const route = routes[key];
        if (!route) continue;
        const retRoute = rt?.returnRoutes[key];
        if (rt && retRoute) {
          const rule = pickRule(rt.rules, v.categoryId);
          const disc = rule ? null : discount; // promo codes are not combined with a round-trip discount
          const rq = calculateRoundTrip(v.config, routeToInput(trip, route, key, disc), routeToInput({ ...trip, tripType: "distance", hours: null }, retRoute, key, disc), rule, extras);
          if (rq.ok) quotes[key] = {
            totalCents: rq.totalCents, currency: rq.currency, lineItems: rq.lineItems, minimumApplied: false,
            tollStatus: rq.legs.some((l) => l.lineItems.some((i) => i.code === "tolls")) ? "included" : key === "no_tolls" ? "avoided" : route.toll.status === "unavailable" || retRoute.toll.status === "unavailable" ? "unavailable" : "included",
            roundTrip: { discountCents: rq.discountCents, twoOneWayCents: rq.twoOneWayCents, ruleLabel: rq.rule?.label ?? null, legs: rq.legs.map((l) => ({ label: l.direction === "outbound" ? "Outbound" : "Return", totalCents: l.totalCents })) },
          };
          continue;
        }
        const q = calculateQuote(v.config, routeToInput(trip, route, key, discount));
        if (q.ok) quotes[key] = toPublicQuote(q, extras);
      }
    }
    const quotable = Object.keys(quotes).length > 0;
    if (trip.tripType === "hourly" && v.config && !quotable) continue; // vehicle has no hourly rate
    out.push({ id: v.id, name: v.name, category: v.category, passengers: v.passengers, image: v.image, similarModels: v.similarModels, description: v.description, capacityLabel: v.capacityLabel, tiers: v.tiers.map((t) => ({ id: t.id, name: t.name, fixedPriceCents: t.fixedPriceCents, meetGreetFeeCents: t.meetGreetFeeCents })), quotable, quotes });
  }
  return out;
}
