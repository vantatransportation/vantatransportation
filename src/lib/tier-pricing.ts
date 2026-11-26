/**
 * Tier pricing and the ONLINE charge (the amount authorized / captured / paid). Pure.
 *
 * The online charge is the COMPLETE final booking total, calculated on the server:
 *   tier fixed/base fee  +  server-calculated trip estimate (distance or hourly fare, surcharges, tolls, discounts,
 *   round-trip pricing)  +  Meet & Greet fee of the tier (if selected)  +  child seats.
 *
 * Customers never see the tier fee or the trip estimate on their own: they see ONE combined "Trip fare"
 * (tier fee + trip estimate), the optional services separately, and the Total. `customerPricing()` is the only
 * function that should shape numbers for a customer-facing surface; `OnlineCharge` itself is internal/admin data.
 */
export const TIER_SLUGS = ["premium", "luxury", "luxury-plus"] as const;
export const TIER_NAMES = ["Premium", "Luxury", "Luxury Plus"] as const;
/** Initial business-approved Meet & Greet fees, as seeded by the migration. Editable in Admin; not used for charging. */
export const INITIAL_MEET_GREET_CENTS = { premium: 2500, luxury: 3500, "luxury-plus": 5000 } as const;
export const MAX_TIER_AMOUNT_CENTS = 1_000_000; // $10,000 sanity ceiling

export interface TierPricing { id: string | null; name: string; fixedPriceCents: number | null; meetGreetFeeCents: number | null }

/** INTERNAL breakdown (admin, database, server logic). Never send this object to a customer. */
export interface OnlineCharge {
  tierId: string | null; tierName: string;
  /** Internal: the tier's fixed/base fee. */
  fixedPriceCents: number;
  /** Internal: the server-calculated trip estimate (distance/hourly fare, surcharges, tolls, discounts, round trip). */
  tripEstimateCents: number;
  meetGreetCents: number; addonsCents: number;
  /** The complete amount payable: fixed + tripEstimate + meetGreet + addons. */
  totalCents: number;
}
export type ChargeResult =
  | { ok: true; charge: OnlineCharge }
  | { ok: false; reason: "tier_missing" | "price_not_set" | "meet_greet_unavailable" | "trip_fare_unavailable" | "invalid" };

const isCents = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

export function onlineCharge(tier: TierPricing | null, opts: { meetGreet: boolean; addonsCents: number; tripEstimateCents: number | null }): ChargeResult {
  if (!tier) return { ok: false, reason: "tier_missing" };
  if (tier.fixedPriceCents == null) return { ok: false, reason: "price_not_set" };
  // No trip estimate = the complete fare is unknown. Never fall back to charging the tier fee alone.
  if (opts.tripEstimateCents == null) return { ok: false, reason: "trip_fare_unavailable" };
  if (!isCents(tier.fixedPriceCents) || !isCents(opts.addonsCents) || !isCents(opts.tripEstimateCents)) return { ok: false, reason: "invalid" };
  let mg = 0;
  if (opts.meetGreet) {
    if (tier.meetGreetFeeCents == null) return { ok: false, reason: "meet_greet_unavailable" };
    if (!isCents(tier.meetGreetFeeCents)) return { ok: false, reason: "invalid" };
    mg = tier.meetGreetFeeCents; // added exactly once, whatever the customer changed before
  }
  return { ok: true, charge: { tierId: tier.id, tierName: tier.name, fixedPriceCents: tier.fixedPriceCents, tripEstimateCents: opts.tripEstimateCents, meetGreetCents: mg, addonsCents: opts.addonsCents, totalCents: tier.fixedPriceCents + opts.tripEstimateCents + mg + opts.addonsCents } };
}

/** The combined trip fare a customer is shown: tier fee + trip estimate. The two parts are never exposed separately. */
export const combinedTripFareCents = (fixedPriceCents: number, tripEstimateCents: number) => fixedPriceCents + tripEstimateCents;

/** The ONLY pricing structure customer-facing surfaces may show. Contains no tier fee, rate or formula. */
export interface CustomerPricing { tripFareCents: number; meetGreetCents: number; childSeatCents: number; totalCents: number }

/**
 * Customer view of a stored booking amount. The trip fare is DERIVED as total minus the separately shown services, so the
 * lines always add up to the stored total exactly (also for older bookings, whatever they were composed of), and no internal
 * component (tier fee, per-mile rate) has to be read, sent or rendered to produce it.
 */
export function customerPricing(totalCents: number, meetGreetCents: number | null | undefined, childSeatCents: number | null | undefined): CustomerPricing {
  const mg = Math.max(0, meetGreetCents ?? 0);
  const seats = Math.max(0, childSeatCents ?? 0);
  return { tripFareCents: totalCents - mg - seats, meetGreetCents: mg, childSeatCents: seats, totalCents };
}

/** Customer view of a freshly calculated charge. */
export const customerPricingOf = (c: OnlineCharge): CustomerPricing => customerPricing(c.totalCents, c.meetGreetCents, c.addonsCents);

/** Validates admin-entered tier amounts (in cents, after money coercion). Blank (null) means "not configured yet". */
export function validateTierPricing(data: Record<string, unknown>): string | null {
  for (const [key, label] of [["fixed_price_cents", "Fixed price"], ["meet_greet_fee_cents", "Meet & Greet fee"]] as const) {
    if (!(key in data) || data[key] === null) continue;
    const v = data[key];
    if (!isCents(v) || v <= 0) return `${label} must be greater than $0.00, or left blank until it is approved.`;
    if (v > MAX_TIER_AMOUNT_CENTS) return `${label} is above the $${(MAX_TIER_AMOUNT_CENTS / 100).toLocaleString("en-US")} limit.`;
  }
  return null;
}

export const CHARGE_REASON_TEXT: Record<string, string> = {
  tier_missing: "This vehicle has no service tier assigned.",
  price_not_set: "The fixed price for this tier has not been set yet.",
  trip_fare_unavailable: "The trip fare could not be calculated for this booking.",
  meet_greet_unavailable: "Airport Meet & Greet is not offered for this tier.",
  invalid: "The configured prices are invalid.",
};
