/** Payment planning. Pure: the amount is derived only from the server-calculated booking total and admin settings. */
export type PaymentMode = "disabled" | "full" | "deposit_fixed" | "deposit_percent";
export interface PaymentSettings { mode: PaymentMode; depositFixedCents: number | null; depositPercent: number | null; terms: string | null }
export const DEFAULT_PAYMENT: PaymentSettings = { mode: "disabled", depositFixedCents: null, depositPercent: null, terms: null };

/** Stripe's minimum charge for USD is $0.50. */
export const MIN_CHARGE_CENTS = 50;

export interface PaymentPlan { kind: "full" | "deposit"; amountCents: number }

/**
 * What the customer should pay now, or null when online payment does not apply (disabled, no price,
 * nothing left to pay, deposit not configured, or below the processor's minimum).
 */
export function paymentPlan(s: PaymentSettings, totalCents: number | null, paidCents: number): PaymentPlan | null {
  if (s.mode === "disabled" || totalCents == null || totalCents <= 0) return null;
  let target: number;
  if (s.mode === "full") target = totalCents;
  else if (s.mode === "deposit_fixed") {
    if (!s.depositFixedCents || s.depositFixedCents <= 0) return null; // not configured: no invented deposit
    target = Math.min(s.depositFixedCents, totalCents);
  } else {
    if (!s.depositPercent || s.depositPercent <= 0) return null;
    target = Math.min(totalCents, Math.round((totalCents * s.depositPercent) / 100));
  }
  const due = target - Math.max(0, paidCents);
  if (due < MIN_CHARGE_CENTS) return null;
  return { kind: target >= totalCents ? "full" : "deposit", amountCents: due };
}

export type PaymentStatus = "not_required" | "unpaid" | "pending" | "deposit_paid" | "paid" | "failed" | "refunded" | "partially_refunded" | "review";

/** Booking-level payment status after money has been received. */
export function statusAfterPayment(totalCents: number | null, paidCents: number): PaymentStatus {
  if (paidCents <= 0) return "unpaid";
  return totalCents != null && paidCents >= totalCents ? "paid" : "deposit_paid";
}

/** Integer cents to a decimal string for providers that use decimal amounts (PayPal): 18500 -> "185.00". No floating point. */
export function centsToDecimal(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error("invalid amount");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
/** "185.00" -> 18500. Returns null for anything that is not a plain non-negative amount with at most two decimals. */
export function decimalToCents(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,9}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
