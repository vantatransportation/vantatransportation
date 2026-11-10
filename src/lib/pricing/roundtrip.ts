/**
 * Round-trip and extras pricing built on the existing single-leg engine. Pure TypeScript.
 * The discount is NOT a hard-coded policy: it comes from an admin-created, active rule, and when
 * there is no rule the round trip is simply the sum of the two legs.
 */
import { calculateQuote, type LineItem, type PricingConfig, type QuoteInput, type QuoteResult } from "./engine";

export interface RoundTripRule { id: string; label: string; kind: "flat" | "percent"; amount: number }
export interface ExtraLine { code: string; label: string; cents: number; detail?: string }
export interface LegResult { leg: 1 | 2; direction: "outbound" | "return"; lineItems: LineItem[]; totalCents: number; eligibleCents: number; snapshot: unknown }

export type RoundTripResult =
  | {
      ok: true; currency: string; legs: LegResult[]; lineItems: LineItem[]; discountCents: number; extrasCents: number; totalCents: number;
      rule: RoundTripRule | null; twoOneWayCents: number;
    }
  | { ok: false; message: string };

const labelled = (prefix: string, items: LineItem[]): LineItem[] => items.map((l) => ({ ...l, label: `${prefix}: ${l.label}` }));

type Ok = Extract<QuoteResult, { ok: true }>;
/** Fare components eligible for the round-trip discount: fare and surcharges, excluding tolls. */
const eligible = (q: Ok) => q.subtotalCents - q.toll.cents;

export function calculateRoundTrip(
  config: PricingConfig, outbound: QuoteInput, ret: QuoteInput, rule: RoundTripRule | null, extras: ExtraLine[] = [],
): RoundTripResult {
  const a = calculateQuote(config, outbound);
  if (!a.ok) return { ok: false, message: a.message };
  const b = calculateQuote(config, ret);
  if (!b.ok) return { ok: false, message: b.message };

  const eligibleCents = eligible(a) + eligible(b);
  let discountCents = 0;
  if (rule && rule.amount > 0) {
    discountCents = rule.kind === "percent" ? Math.round((eligibleCents * Math.min(rule.amount, 100)) / 100) : Math.round(rule.amount * 100);
    discountCents = Math.min(discountCents, eligibleCents);
  }
  const items: LineItem[] = [...labelled("Outbound", a.lineItems), ...labelled("Return", b.lineItems)];
  if (discountCents > 0 && rule) items.push({ code: "round_trip_discount", label: rule.label, cents: -discountCents, detail: rule.kind === "percent" ? `${rule.amount}% off fare components` : undefined });
  const extrasCents = extras.reduce((s, e) => s + e.cents, 0);
  for (const e of extras) items.push(e);
  const twoOneWayCents = a.totalCents + b.totalCents;
  return {
    ok: true, currency: config.currency, discountCents, extrasCents, rule: discountCents > 0 ? rule : null, twoOneWayCents,
    totalCents: twoOneWayCents - discountCents + extrasCents, lineItems: items,
    legs: [
      { leg: 1, direction: "outbound", lineItems: a.lineItems, totalCents: a.totalCents, eligibleCents: eligible(a), snapshot: a.snapshot },
      { leg: 2, direction: "return", lineItems: b.lineItems, totalCents: b.totalCents, eligibleCents: eligible(b), snapshot: b.snapshot },
    ],
  };
}

/** Adds approved extras (for example Meet & Greet) to a one-way quote. */
export function withExtras(q: Ok, extras: ExtraLine[]) {
  const extrasCents = extras.reduce((s, e) => s + e.cents, 0);
  return { lineItems: [...q.lineItems, ...extras], totalCents: q.totalCents + extrasCents, extrasCents };
}

/** Waiting charge in whole increments after the included period. Returns null when no approved rate exists. */
export function waitingCharge(minutesWaited: number, includedMinutes: number, incrementMinutes: number, rateCentsPerIncrement: number | null) {
  const over = Math.max(0, minutesWaited - includedMinutes);
  const increments = incrementMinutes > 0 ? Math.ceil(over / incrementMinutes) : 0;
  return { billableMinutes: increments * incrementMinutes, increments, cents: rateCentsPerIncrement == null ? null : increments * rateCentsPerIncrement };
}
