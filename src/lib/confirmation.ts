import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AWAITING_REVIEW, isOpenForDriver, type BookingStatus } from "@/lib/booking-status";
import { loadBookingSettings } from "@/lib/policies";
import { availableProviders } from "@/lib/payment-providers";
import { paymentPlan } from "@/lib/payments";
import { customerPricing, type CustomerPricing } from "@/lib/tier-pricing";
import { validToken } from "@/lib/payments-server";
import { normalizeTrackingCode } from "@/lib/tracking";

/**
 * What the customer's own post-booking page may show, reached with the booking's PRIVATE payment token (never the guessable VT- reference).
 * Customer-safe only: the reference, the tracking ID (the customer's own credential), the combined price and the state of the card step.
 * Nothing internal: no database ids, tier fee, admin notes, driver details, phone numbers or payment-provider references.
 */
export type CardState =
  | "paid"        // money captured and verified
  | "held"        // card authorized: a hold, not a charge; captured when an admin approves the booking
  | "pending"     // the hosted card page was started but Stripe has not confirmed a hold yet
  | "failed"      // the last attempt was declined or failed
  | "ended"       // an earlier hold or page expired or was released
  | "none";       // nothing started yet

export interface ConfirmationView {
  reference: string; trackingCode: string | null; currency: string; status: BookingStatus;
  pricing: (CustomerPricing & { currency: string }) | null;
  card: CardState;
  /** The customer can start or resume the card step right now (booking awaiting review, authorize-at-booking on, nothing held). */
  canAuthorize: boolean;
  /** Approved and released for payment: the existing secure pay page applies instead. */
  payPath: string | null;
  closed: boolean;
}

const HELD = ["authorized", "capture_pending", "capture_failed"];

export async function loadConfirmation(db: SupabaseClient, token: unknown): Promise<ConfirmationView | null> {
  if (!validToken(token)) return null;
  const { data: b } = await db.from("bookings").select("id,reference,status,tracking_code,currency,online_amount_cents,meet_greet_selected,meet_greet_fee_cents,child_seat_fee_cents,payment_status,payment_released_at,driver_id,amount_paid_cents").eq("payment_token", token).maybeSingle();
  if (!b) return null;
  const status = b.status as BookingStatus;
  const closed = ["cancelled", "no_show", "rejected", "completed"].includes(status);
  const { data: rows } = await db.from("payments").select("status,provider,manual_capture,created_at").eq("booking_id", b.id).order("created_at", { ascending: false });
  const stripeRows = (rows ?? []).filter((p: Record<string, unknown>) => p.provider === "stripe" && p.manual_capture === true);
  const paid = ["paid", "deposit_paid", "partially_refunded", "refunded"].includes(String(b.payment_status));
  const latest = stripeRows[0]?.status as string | undefined;
  const held = stripeRows.some((p: Record<string, unknown>) => HELD.includes(String(p.status)));
  const card: CardState = paid ? "paid" : held ? "held" : latest === "pending" ? "pending" : latest === "failed" ? "failed" : latest ? "ended" : "none";
  const hasAmount = b.online_amount_cents != null;
  const settings = await loadBookingSettings(db);
  const plan = hasAmount ? paymentPlan(settings.payment, b.online_amount_cents, b.amount_paid_cents ?? 0) : null;
  const canAuthorize = !closed && !paid && !held && AWAITING_REVIEW.includes(status) && settings.authorizeAtBooking && availableProviders(settings).includes("stripe") && plan != null;
  const released = Boolean(b.payment_released_at && b.driver_id) && isOpenForDriver(status);
  return {
    reference: b.reference, trackingCode: normalizeTrackingCode(b.tracking_code), currency: b.currency ?? "USD", status,
    pricing: hasAmount ? { ...customerPricing(b.online_amount_cents, b.meet_greet_selected ? b.meet_greet_fee_cents : 0, b.child_seat_fee_cents), currency: b.currency ?? "USD" } : null,
    card, canAuthorize, payPath: released && !paid && !closed ? `/pay/${token}` : null, closed,
  };
}
