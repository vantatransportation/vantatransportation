/**
 * Fixed tier pricing and the ONLINE charge. Pure.
 *
 * The online charge is deliberately separate from the trip estimate. It is exactly:
 *   fixed price of the selected tier  +  Meet & Greet fee of that tier (if selected)  +  other explicit add-ons (child seats).
 * Mileage, hourly, duration, toll and other trip-based amounts are NEVER part of it.
 */
export const TIER_SLUGS = ["premium", "luxury", "luxury-plus"] as const;
export const TIER_NAMES = ["Premium", "Luxury", "Luxury Plus"] as const;
/** Initial business-approved Meet & Greet fees, as seeded by the migration. Editable in Admin; not used for charging. */
export const INITIAL_MEET_GREET_CENTS = { premium: 2500, luxury: 3500, "luxury-plus": 5000 } as const;
export const MAX_TIER_AMOUNT_CENTS = 1_000_000; // $10,000 sanity ceiling

export interface TierPricing { id: string | null; name: string; fixedPriceCents: number | null; meetGreetFeeCents: number | null }

export interface OnlineCharge {
  tierId: string | null; tierName: string;
  fixedPriceCents: number; meetGreetCents: number; addonsCents: number; totalCents: number;
}
export type ChargeResult =
  | { ok: true; charge: OnlineCharge }
  | { ok: false; reason: "tier_missing" | "price_not_set" | "meet_greet_unavailable" | "invalid" };

const isCents = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

export function onlineCharge(tier: TierPricing | null, opts: { meetGreet: boolean; addonsCents: number }): ChargeResult {
  if (!tier) return { ok: false, reason: "tier_missing" };
  if (tier.fixedPriceCents == null) return { ok: false, reason: "price_not_set" };
  if (!isCents(tier.fixedPriceCents) || !isCents(opts.addonsCents)) return { ok: false, reason: "invalid" };
  let mg = 0;
  if (opts.meetGreet) {
    if (tier.meetGreetFeeCents == null) return { ok: false, reason: "meet_greet_unavailable" };
    if (!isCents(tier.meetGreetFeeCents)) return { ok: false, reason: "invalid" };
    mg = tier.meetGreetFeeCents; // added exactly once, whatever the customer changed before
  }
  return { ok: true, charge: { tierId: tier.id, tierName: tier.name, fixedPriceCents: tier.fixedPriceCents, meetGreetCents: mg, addonsCents: opts.addonsCents, totalCents: tier.fixedPriceCents + mg + opts.addonsCents } };
}

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
  meet_greet_unavailable: "Airport Meet & Greet is not offered for this tier.",
  invalid: "The configured prices are invalid.",
};
