/**
 * Centralized pricing engine. Pure TypeScript, no framework or database imports,
 * so it runs identically on the server (authoritative) and in tests.
 *
 * All money is calculated in integer cents to avoid floating-point drift.
 * The browser may display a preview, but the booking API must always call
 * `calculateQuote` again with the pricing config loaded from the database.
 */

export type TripType = "distance" | "hourly";
export type AdjustmentKind = "flat" | "percent";

export interface Surcharge {
  id: string;
  label: string;
  kind: AdjustmentKind;
  /** Dollars when kind = "flat", percentage points when kind = "percent". */
  amount: number;
}

export interface PricingConfig {
  id: string;
  vehicleId: string;
  /** Only "active" configs may be used for customer quotes. */
  status: "draft" | "active" | "archived";
  currency: string;
  perMile: number;
  hourlyRate: number | null;
  minimumFare: number;
  baseFare: number;
  /** Miles included in an hourly booking. */
  hourlyIncludedMiles: number;
  /** "booking" = allowance applies once; "per_hour" = allowance multiplies by billable hours. */
  hourlyIncludedScope: "booking" | "per_hour";
  hourlyExtraMileRate: number;
  /** Minimum billable hours for hourly bookings. */
  minHours: number;
  /** Optional long-trip rule: miles beyond this threshold use longTripPerMile. */
  longTripThresholdMiles: number | null;
  longTripPerMile: number | null;
  surcharges: Surcharge[];
}

export interface DiscountInput {
  label: string;
  kind: AdjustmentKind;
  amount: number;
  /** Discounts are only applied once a human has approved them. */
  approved: boolean;
}

export interface QuoteInput {
  tripType: TripType;
  distanceMiles: number;
  /** Required for hourly trips. */
  hours?: number;
  durationMinutes?: number;
  /** Dollars. null/undefined means a toll estimate is unavailable. */
  tollAmount?: number | null;
  avoidTolls?: boolean;
  discount?: DiscountInput | null;
}

export interface LineItem {
  code: string;
  label: string;
  cents: number;
  detail?: string;
}

export type QuoteErrorCode =
  | "pricing_unpublished"
  | "invalid_input"
  | "hourly_not_supported";

export type QuoteResult =
  | {
      ok: true;
      currency: string;
      lineItems: LineItem[];
      subtotalCents: number;
      discountCents: number;
      totalCents: number;
      minimumApplied: boolean;
      toll: { status: "included" | "unavailable" | "avoided"; cents: number };
      /** Store this with the booking so later rate changes never alter it. */
      snapshot: {
        config: PricingConfig;
        input: QuoteInput;
        computedAt: string;
      };
    }
  | { ok: false; error: QuoteErrorCode; message: string };

export interface QuoteOptions {
  /** Admin previews only. Never set this for customer-facing quotes. */
  allowDraft?: boolean;
  now?: Date;
}

const toCents = (dollars: number) => Math.round(dollars * 100);
const isNum = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);
const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100,
  );
}

function fail(error: QuoteErrorCode, message: string): QuoteResult {
  return { ok: false, error, message };
}

export function calculateQuote(
  config: PricingConfig,
  input: QuoteInput,
  options: QuoteOptions = {},
): QuoteResult {
  if (config.status !== "active" && !options.allowDraft) {
    return fail(
      "pricing_unpublished",
      "Pricing for this vehicle has not been published yet.",
    );
  }
  if (!isNum(input.distanceMiles) || input.distanceMiles < 0) {
    return fail("invalid_input", "Distance must be zero or more miles.");
  }
  if (
    input.tollAmount != null &&
    (!isNum(input.tollAmount) || input.tollAmount < 0)
  ) {
    return fail("invalid_input", "Toll amount must be zero or more.");
  }

  const items: LineItem[] = [];
  const miles = input.distanceMiles;
  let coreCents = 0;

  if (input.tripType === "hourly") {
    if (config.hourlyRate == null) {
      return fail(
        "hourly_not_supported",
        "Hourly booking is not available for this vehicle.",
      );
    }
    if (!isNum(input.hours) || input.hours <= 0) {
      return fail("invalid_input", "Hourly bookings need a number of hours.");
    }
    const billableHours = Math.max(input.hours, config.minHours);
    const hourlyCents = toCents(billableHours * config.hourlyRate);
    items.push({
      code: "hourly",
      label: "Chauffeur time",
      cents: hourlyCents,
      detail: `${fmt(billableHours)} h × ${formatMoney(toCents(config.hourlyRate), config.currency)}/h`,
    });
    coreCents += hourlyCents;

    const included =
      config.hourlyIncludedScope === "per_hour"
        ? config.hourlyIncludedMiles * billableHours
        : config.hourlyIncludedMiles;
    const extraMiles = Math.max(0, miles - included);
    if (extraMiles > 0) {
      const extraCents = toCents(extraMiles * config.hourlyExtraMileRate);
      items.push({
        code: "extra_miles",
        label: "Additional mileage",
        cents: extraCents,
        detail: `${fmt(extraMiles)} mi beyond ${fmt(included)} included × ${formatMoney(toCents(config.hourlyExtraMileRate), config.currency)}/mi`,
      });
      coreCents += extraCents;
    }
  } else {
    if (config.baseFare > 0) {
      const baseCents = toCents(config.baseFare);
      items.push({ code: "base", label: "Base fare", cents: baseCents });
      coreCents += baseCents;
    }
    const threshold = config.longTripThresholdMiles;
    const longRate = config.longTripPerMile;
    if (threshold != null && longRate != null && miles > threshold) {
      const standardCents = toCents(threshold * config.perMile);
      const longMiles = miles - threshold;
      const longCents = toCents(longMiles * longRate);
      items.push({
        code: "distance",
        label: "Distance",
        cents: standardCents,
        detail: `${fmt(threshold)} mi × ${formatMoney(toCents(config.perMile), config.currency)}/mi`,
      });
      items.push({
        code: "long_trip",
        label: "Long-trip distance",
        cents: longCents,
        detail: `${fmt(longMiles)} mi × ${formatMoney(toCents(longRate), config.currency)}/mi`,
      });
      coreCents += standardCents + longCents;
    } else {
      const distCents = toCents(miles * config.perMile);
      items.push({
        code: "distance",
        label: "Distance",
        cents: distCents,
        detail: `${fmt(miles)} mi × ${formatMoney(toCents(config.perMile), config.currency)}/mi`,
      });
      coreCents += distCents;
    }
  }

  let minimumApplied = false;
  const minCents = toCents(config.minimumFare);
  if (coreCents < minCents) {
    items.push({
      code: "minimum",
      label: "Minimum fare adjustment",
      cents: minCents - coreCents,
      detail: `Minimum fare ${formatMoney(minCents, config.currency)}`,
    });
    coreCents = minCents;
    minimumApplied = true;
  }

  let fareCents = coreCents;
  for (const s of config.surcharges) {
    if (!isNum(s.amount) || s.amount < 0) continue;
    const cents =
      s.kind === "percent" ? Math.round((coreCents * s.amount) / 100) : toCents(s.amount);
    if (cents > 0) {
      items.push({
        code: `surcharge:${s.id}`,
        label: s.label,
        cents,
        detail: s.kind === "percent" ? `${fmt(s.amount)}%` : undefined,
      });
      fareCents += cents;
    }
  }

  let discountCents = 0;
  const d = input.discount;
  if (d && d.approved && isNum(d.amount) && d.amount > 0) {
    discountCents =
      d.kind === "percent"
        ? Math.round((fareCents * Math.min(d.amount, 100)) / 100)
        : toCents(d.amount);
    discountCents = Math.min(discountCents, fareCents);
  }

  let toll: { status: "included" | "unavailable" | "avoided"; cents: number };
  if (input.avoidTolls) {
    toll = { status: "avoided", cents: 0 };
  } else if (input.tollAmount == null) {
    toll = { status: "unavailable", cents: 0 };
  } else {
    toll = { status: "included", cents: toCents(input.tollAmount) };
    if (toll.cents > 0) {
      items.push({ code: "tolls", label: "Estimated tolls", cents: toll.cents });
    }
  }

  if (discountCents > 0 && d) {
    items.push({ code: "discount", label: d.label, cents: -discountCents });
  }

  const subtotalCents = fareCents + toll.cents;
  const totalCents = subtotalCents - discountCents;

  return {
    ok: true,
    currency: config.currency,
    lineItems: items,
    subtotalCents,
    discountCents,
    totalCents,
    minimumApplied,
    toll,
    snapshot: {
      config,
      input,
      computedAt: (options.now ?? new Date()).toISOString(),
    },
  };
}
