import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtraLine, RoundTripRule } from "@/lib/pricing/roundtrip";
import { DEFAULT_PAYMENT, type PaymentMode, type PaymentSettings } from "@/lib/payments";
import { clampDispatchMinutes, DEFAULT_DISPATCH_MINUTES } from "@/lib/booking-status";
import { childSeatFee, childSeatSummary, DEFAULT_SEAT_SETTINGS, seatCount, type ChildSeats, type SeatSettings } from "@/lib/child-seats";

export interface BookingSettings {
  /** Whether airport Meet & Greet can be requested. Its fee is set per tier (vehicle_tiers.meet_greet_fee_cents). */
  meetGreetEnabled: boolean;
  /** Provider switches; a provider is offered only if enabled here AND configured on the server. */
  stripeEnabled: boolean;
  paypalEnabled: boolean;
  waitingIncludedMinutes: number;
  waitingIncrementMinutes: number;
  /** Only set when an admin has approved the rate. */
  waitingRateCents: number | null;
  /** Minutes before pickup when a driver may tap Leave for Pickup. */
  dispatchWindowMinutes: number;
  seats: SeatSettings;
  payment: PaymentSettings;
}

export type { PaymentMode, PaymentSettings } from "@/lib/payments";

export const DEFAULT_SETTINGS: BookingSettings = { meetGreetEnabled: true, stripeEnabled: true, paypalEnabled: true, waitingIncludedMinutes: 15, waitingIncrementMinutes: 15, waitingRateCents: null, dispatchWindowMinutes: DEFAULT_DISPATCH_MINUTES, seats: DEFAULT_SEAT_SETTINGS, payment: DEFAULT_PAYMENT };

export async function loadBookingSettings(db: SupabaseClient): Promise<BookingSettings> {
  try {
    const { data } = await db.from("booking_settings").select("*").limit(1).maybeSingle();
    if (!data) return DEFAULT_SETTINGS;
    return {
      meetGreetEnabled: data.meet_greet_enabled !== false,
      stripeEnabled: data.stripe_enabled !== false,
      paypalEnabled: data.paypal_enabled !== false,
      waitingIncludedMinutes: Number(data.waiting_included_minutes ?? 15),
      waitingIncrementMinutes: Number(data.waiting_increment_minutes ?? 15) || 15,
      waitingRateCents: data.waiting_rate_approved && data.waiting_rate_cents != null ? Number(data.waiting_rate_cents) : null,
      dispatchWindowMinutes: clampDispatchMinutes(data.driver_dispatch_window_minutes),
      seats: {
        oneWayCents: Number(data.child_seat_one_way_cents ?? DEFAULT_SEAT_SETTINGS.oneWayCents),
        roundTripCents: Number(data.child_seat_round_trip_cents ?? DEFAULT_SEAT_SETTINGS.roundTripCents),
        max: Number(data.child_seat_max ?? DEFAULT_SEAT_SETTINGS.max),
      },
      payment: {
        mode: (["full", "deposit_fixed", "deposit_percent"].includes(String(data.payment_mode)) ? data.payment_mode : "disabled") as PaymentMode,
        depositFixedCents: data.deposit_fixed_cents != null ? Number(data.deposit_fixed_cents) : null,
        depositPercent: data.deposit_percent != null ? Number(data.deposit_percent) : null,
        terms: typeof data.payment_terms === "string" && data.payment_terms.trim() ? data.payment_terms.trim() : null,
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export const waitingPolicyText = (included: number, step: number) =>
  `Your booking includes ${included} minutes of waiting time. Additional waiting time beyond the included ${included} minutes may incur waiting charges, calculated in ${step}-minute increments.`;

export const DEFAULT_POLICY_TEXT = {
  noShow: "If a passenger does not show up for the confirmed pickup, the full applicable trip price may be charged in accordance with the company's no-show policy. If you cannot locate your driver or need help with pickup arrangements, please contact Vanta right away.",
  assistance: "Our drivers aim to provide thoughtful, passenger-conscious service and reasonable assistance throughout your journey, including helping passengers with luggage and getting in and out of the vehicle when reasonably possible.",
  availability: "You can submit a request at any time. Availability and final confirmation depend on the location, driver or affiliate availability and applicable booking rules.",
};

export interface PublicPolicies {
  waitingText: string; noShowText: string; assistanceText: string; availabilityText: string;
  meetGreet: { enabled: boolean };
  roundTripDiscountActive: boolean;
}

export async function loadPublicPolicies(db: SupabaseClient | null): Promise<PublicPolicies> {
  let s = DEFAULT_SETTINGS; let noShow = DEFAULT_POLICY_TEXT.noShow, assistance = DEFAULT_POLICY_TEXT.assistance, availability = DEFAULT_POLICY_TEXT.availability;
  let rtActive = false;
  if (db) {
    s = await loadBookingSettings(db);
    try {
      const { data } = await db.from("site_content").select("key,value").in("key", ["policy.no_show", "policy.assistance", "policy.availability"]);
      for (const r of data ?? []) {
        if (typeof r.value !== "string" || !r.value.trim()) continue;
        if (r.key === "policy.no_show") noShow = r.value; else if (r.key === "policy.assistance") assistance = r.value; else if (r.key === "policy.availability") availability = r.value;
      }
    } catch { /* defaults */ }
    rtActive = (await loadActiveRoundTripRules(db)).length > 0;
  }
  return {
    waitingText: waitingPolicyText(s.waitingIncludedMinutes, s.waitingIncrementMinutes), noShowText: noShow, assistanceText: assistance, availabilityText: availability,
    meetGreet: { enabled: s.meetGreetEnabled }, roundTripDiscountActive: rtActive,
  };
}

export interface RuleRow extends RoundTripRule { categoryId: string | null }

export async function loadActiveRoundTripRules(db: SupabaseClient): Promise<RuleRow[]> {
  try {
    const { data } = await db.from("round_trip_rules").select("id,label,kind,amount,category_id,starts_at,ends_at").eq("is_active", true);
    const now = Date.now();
    return (data ?? [])
      .filter((r: Record<string, unknown>) => (!r.starts_at || new Date(String(r.starts_at)).getTime() <= now) && (!r.ends_at || new Date(String(r.ends_at)).getTime() >= now))
      .map((r: Record<string, unknown>) => ({ id: String(r.id), label: String(r.label), kind: r.kind as "flat" | "percent", amount: Number(r.amount), categoryId: (r.category_id as string | null) ?? null }));
  } catch {
    return [];
  }
}

/** Picks the rule for a vehicle category: a category-specific rule beats an all-categories one. */
export function pickRule(rules: RuleRow[], categoryId: string | null): RoundTripRule | null {
  const specific = rules.find((r) => r.categoryId && r.categoryId === categoryId);
  const any = rules.find((r) => !r.categoryId);
  const r = specific ?? any;
  return r ? { id: r.id, label: r.label, kind: r.kind, amount: r.amount } : null;
}

/**
 * The child-seat charge for a trip, as an extra line. Validates against the admin-configured maximum.
 * One-way: one-way rate per seat. Round trip: the round-trip rate per seat, charged once (not per leg).
 */
export function seatExtra(settings: SeatSettings, seats: ChildSeats, roundTrip: boolean, passengers: number): { ok: true; line: ExtraLine | null } | { ok: false; error: string } {
  const n = seatCount(seats);
  if (n === 0) return { ok: true, line: null };
  if (n > settings.max) return { ok: false, error: `You can request up to ${settings.max} child seats online. Please contact us for more.` };
  if (n > passengers) return { ok: false, error: "You cannot request more child seats than passengers." };
  const fee = childSeatFee(seats, roundTrip, settings);
  return { ok: true, line: { code: "child_seat", label: `Child car seats (${childSeatSummary(seats)})`, cents: fee.totalCents, detail: `${(fee.eachCents / 100).toFixed(2)} per seat, ${roundTrip ? "round trip" : "one way"}. Requested, subject to confirmation.` } };
}
