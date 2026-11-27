/**
 * Where a booking stands in the saved-card workflow, from REAL stored facts only. Pure (no server-only imports), so the customer tracker, the
 * customer's booking page, the admin dashboard and the tests all use ONE definition and cannot disagree.
 *
 *   card saved (nothing charged) -> awaiting admin approval -> approved: awaiting customer confirmation -> payment processing / needs action / failed
 *   -> confirmed and paid -> (admin assigns a driver)
 */
import { AWAITING_REVIEW, PAID_STATES, awaitingCustomerConfirmation, isTerminal, type BookingStatus } from "@/lib/booking-status";

export type CustomerStage =
  | "card_needed"            // request saved, the card step is not finished (nothing is with the admin yet)
  | "awaiting_approval"      // card saved (or no card needed): waiting for the admin
  | "approved_card_needed"   // approved, but no card is saved yet (older booking): add one, then confirm
  | "approved_ready"         // approved and a card is saved: show "Confirm Booking & Authorize Charge"
  | "action_required"        // the bank needs the customer to authenticate the charge
  | "processing"             // the charge was submitted; waiting for Stripe's verified result
  | "payment_failed"         // the last charge attempt failed; the customer can retry or use another card
  | "no_online_payment"      // approved, but no online amount exists: the business arranges payment directly
  | "review"                 // a payment did not match and is being reviewed by the business
  | "confirmed"              // confirmed after a verified payment (a driver is assigned later)
  | "closed";                // declined, cancelled, no-show or completed

export interface StageFacts {
  status: string; card_flow?: boolean | null; card_setup_at?: string | null; approved_at?: string | null; confirmed_at?: string | null;
  payment_released_at?: string | null; payment_status?: string | null; online_amount_cents?: number | null;
  /** Status of the most recent saved-card charge attempt, if any (payments.status). */
  latest_charge_status?: string | null;
}

export function customerStage(f: StageFacts): CustomerStage {
  const status = f.status as BookingStatus;
  if (isTerminal(status)) return "closed";
  if (f.payment_status === "review") return "review";
  if (f.confirmed_at || PAID_STATES.includes(String(f.payment_status))) return "confirmed";
  if (AWAITING_REVIEW.includes(status)) return f.card_flow && !f.card_setup_at ? "card_needed" : "awaiting_approval";
  if (awaitingCustomerConfirmation(f)) {
    if (f.online_amount_cents == null) return "no_online_payment";
    if (f.latest_charge_status === "requires_action") return "action_required";
    if (f.latest_charge_status === "processing") return "processing";
    if (f.latest_charge_status === "failed" || f.payment_status === "failed") return "payment_failed";
    return f.card_setup_at ? "approved_ready" : "approved_card_needed";
  }
  return status === "confirmed" ? "confirmed" : "closed";
}

/** Plain customer-facing headline for each stage. No internal terms, no prices. */
export const STAGE_HEADLINE: Record<CustomerStage, string> = {
  card_needed: "Add your card to complete your request",
  awaiting_approval: "Booking Request Received: Awaiting Admin Approval",
  approved_card_needed: "Approved: add a card, then confirm your booking",
  approved_ready: "Approved: please confirm your booking",
  action_required: "Your bank needs you to authenticate the payment",
  processing: "Payment processing",
  payment_failed: "Payment did not go through: try again",
  no_online_payment: "Approved: we will arrange payment with you",
  review: "We are reviewing your payment",
  confirmed: "Booking confirmed and paid",
  closed: "This booking is closed",
};

export interface AdminChecklistItem { key: string; label: string; done: boolean; at: string | null; note?: string }

/** What the admin dashboard shows: each recorded step on its own, so approval and customer confirmation are never confused. */
export function adminChecklist(f: StageFacts & { customer_confirmed_at?: string | null; driver_id?: string | null }): { items: AdminChecklistItem[]; headline: string } {
  const stage = customerStage(f);
  const paid = PAID_STATES.includes(String(f.payment_status));
  const items: AdminChecklistItem[] = [
    { key: "card", label: "Card setup completed (nothing charged, no hold)", done: Boolean(f.card_setup_at), at: f.card_setup_at ?? null, note: !f.card_setup_at && f.card_flow ? "The customer has not finished adding a card." : undefined },
    { key: "approval", label: "Admin approval", done: Boolean(f.approved_at), at: f.approved_at ?? null },
    { key: "customer", label: "Customer confirmation received", done: Boolean(f.customer_confirmed_at), at: f.customer_confirmed_at ?? null },
    { key: "payment", label: "Payment successfully completed (verified by Stripe/PayPal)", done: paid, at: null, note: f.payment_status === "processing" ? "Payment processing" : f.payment_status === "requires_action" ? "Waiting for the customer to authenticate with their bank" : f.payment_status === "failed" ? "Payment failed" : undefined },
    { key: "confirmed", label: f.driver_id ? "Booking confirmed, driver assigned" : "Booking confirmed and ready for driver assignment", done: Boolean(f.confirmed_at), at: f.confirmed_at ?? null },
  ];
  const headline =
    stage === "closed" ? "Closed" : stage === "review" ? "Payment under review" :
    stage === "card_needed" ? "Card setup not completed" : stage === "awaiting_approval" ? (f.card_setup_at ? "Card saved: awaiting admin approval" : "Awaiting admin approval") :
    stage === "approved_card_needed" ? "Approved: customer must add a card, then confirm" : stage === "approved_ready" ? "Approved: awaiting customer confirmation" :
    stage === "action_required" ? "Customer confirmed: waiting for bank authentication" : stage === "processing" ? "Customer confirmed: payment processing" :
    stage === "payment_failed" ? "Payment failed: customer can retry" : stage === "no_online_payment" ? "Approved: no online amount, payment arranged directly" :
    f.driver_id ? "Confirmed and paid: driver assigned" : "Confirmed and paid: ready for driver assignment";
  return { items, headline };
}
