/** Verification of PayPal orders and captures against what the SERVER asked for. Pure, so it is easy to test. */
import { decimalToCents } from "./payments.ts";

export interface PayPalExpectation { amountCents: number; currency: string; bookingId: string; paymentId: string }
export type CaptureVerdict =
  | { ok: true; state: "completed" | "pending"; captureId: string }
  | { ok: false; state: "declined" | "mismatch" | "invalid"; error: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function verifyPayPalOrder(order: any, exp: PayPalExpectation): CaptureVerdict {
  const unit = order?.purchase_units?.[0];
  const cap = unit?.payments?.captures?.[0];
  if (!unit || !cap?.id) return { ok: false, state: "invalid", error: "No capture found on the order." };
  // The order must be the one we created for this booking and payment attempt.
  if (unit.custom_id !== exp.bookingId || unit.reference_id !== exp.paymentId) return { ok: false, state: "mismatch", error: "Order does not belong to this payment." };
  const cents = decimalToCents(cap.amount?.value);
  if (cents === null || cents !== exp.amountCents || String(cap.amount?.currency_code).toUpperCase() !== exp.currency.toUpperCase()) {
    return { ok: false, state: "mismatch", error: "Captured amount or currency does not match." };
  }
  const status = String(cap.status).toUpperCase();
  if (status === "COMPLETED") return { ok: true, state: "completed", captureId: String(cap.id) };
  if (status === "PENDING") return { ok: true, state: "pending", captureId: String(cap.id) };
  return { ok: false, state: "declined", error: `Capture status ${status}.` };
}
