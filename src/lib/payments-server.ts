import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBookingSettings } from "@/lib/policies";
import { decimalToCents, paymentPlan } from "@/lib/payments";
import { cancelPaymentIntent, retrievePaymentIntent, type StripePI } from "@/lib/stripe";
import { captureOrder, createOrder } from "@/lib/paypal";
import { verifyPayPalOrder } from "@/lib/paypal-verify";
import { availableProviders, type Provider } from "@/lib/payment-providers";
import { formatMoney } from "@/lib/pricing/engine";
import { awaitingCustomerConfirmation } from "@/lib/booking-status";
import { BOOKING_COLUMNS, adminAlert, chargeForBooking, customerLines, flagForReview, recordPaid, syncBooking, validToken, type Row } from "@/lib/payments-core";
import { onSavedCardEvent } from "@/lib/saved-card";

// Re-exported for the routes and pages that already import them from here.
export { chargeForBooking, customerLines, validToken };
export type { Provider };

export type CheckoutOutcome =
  | { ok: true; provider: "paypal"; orderId: string }
  | { ok: false; status: number; error: string };

/**
 * PayPal checkout for an APPROVED booking (PayPal remains available as an alternative to the saved card). The amount is recalculated here from the
 * database; the only things the browser supplies are the private booking token and the provider.
 *
 * There is NO payment link and NO hosted-Stripe checkout any more: card payments are made with the card the customer saved at booking, on their own
 * booking page, only after admin approval and their explicit confirmation (see saved-card.ts). Asking for the old "stripe" provider here is refused.
 */
export async function startCheckout(db: SupabaseClient, token: string, provider: Provider | string, _siteUrl?: string): Promise<CheckoutOutcome> {
  if (provider !== "paypal") return { ok: false, status: 400, error: "Card payments are made on your booking page with the card you saved. Open your booking, review it and choose Confirm Booking & Authorize Charge." };
  const { data: b } = await db.from("bookings").select(BOOKING_COLUMNS).eq("payment_token", token).maybeSingle();
  if (!b) return { ok: false, status: 404, error: "We could not find that booking." };
  if (b.status === "cancelled" || b.status === "no_show" || b.status === "rejected" || b.status === "completed") return { ok: false, status: 409, error: "This booking can no longer be paid online. Please contact us." };
  // Payment opens only AFTER an admin approved the booking (approved_at is set by the admin route alone). A token alone is not enough.
  if (!awaitingCustomerConfirmation(b as never)) return { ok: false, status: 409, error: "This booking has not been approved yet. You will be able to review and confirm it on your booking page once it is approved. You have not been charged." };
  const settings = await loadBookingSettings(db);
  if (!availableProviders(settings).includes("paypal")) return { ok: false, status: 503, error: "PayPal is not available right now. Please confirm with your saved card on your booking page, or contact us." };
  const c = await chargeForBooking(db, b);
  if (!c.ok) return { ok: false, status: 409, error: c.error };
  const { charge } = c;
  const plan = paymentPlan(settings.payment, charge.totalCents, b.amount_paid_cents ?? 0);
  if (!plan) return { ok: false, status: 409, error: "There is nothing to pay online for this booking right now." };

  // A card charge that is in progress (or waiting for the customer's bank) must finish first: the customer is never charged twice.
  const { data: live } = await db.from("payments").select("id").eq("booking_id", b.id).eq("saved_card", true).in("status", ["processing", "requires_action"]);
  if (live?.length) return { ok: false, status: 409, error: "A card payment for this booking is already in progress. Please finish it on your booking page first." };

  // Retire any earlier unpaid PayPal attempt so the customer cannot pay twice.
  const { data: open } = await db.from("payments").select("id").eq("booking_id", b.id).eq("provider", "paypal").eq("status", "pending");
  for (const p of open ?? []) await db.from("payments").update({ status: "expired" }).eq("id", p.id);

  const currency = b.currency ?? "USD";
  const ins = await db.from("payments").insert({
    booking_id: b.id, provider: "paypal", amount_cents: plan.amountCents, currency, kind: plan.kind, status: "pending",
    tier_id: charge.tierId, tier_name: charge.tierName, fixed_price_cents: charge.fixedPriceCents, meet_greet_cents: charge.meetGreetCents,
    other_addons_cents: charge.addonsCents, estimated_trip_fare_cents: charge.tripEstimateCents,
  }).select("id").single();
  if (ins.error) return { ok: false, status: 500, error: "Could not start the payment. Please try again." };
  const paymentId: string = ins.data.id;
  const lines = customerLines(charge, String(b.reference), plan.amountCents);
  const o = await createOrder({ amountCents: plan.amountCents, currency, bookingId: b.id, paymentId, reference: b.reference, description: `Vanta Transportation booking ${b.reference}`, items: lines, requestId: `order-${paymentId}` });
  if (!o.ok) {
    console.error("[payments] paypal checkout failed", o.error);
    await db.from("payments").update({ status: "failed", failure_reason: o.error.slice(0, 300) }).eq("id", paymentId);
    return { ok: false, status: 502, error: "We could not reach the payment provider. Your booking is saved; please try again shortly." };
  }
  await db.from("payments").update({ provider_ref: o.orderId }).eq("id", paymentId);
  await db.from("bookings").update({ payment_status: "pending" }).eq("id", b.id);
  return { ok: true, provider: "paypal", orderId: o.orderId };
}

// ---------------------------------------------------------------- PayPal capture (called by the browser after approval)
export type CaptureOutcome = { ok: true; status: "paid" | "pending" } | { ok: false; status: number; error: string };

/**
 * Captures a PayPal order on the server and verifies the captured amount, currency, order and booking against the
 * payment attempt we created. A browser callback alone never marks anything paid.
 */
export async function capturePayPal(db: SupabaseClient, token: string, orderId: string): Promise<CaptureOutcome> {
  if (typeof orderId !== "string" || !/^[A-Z0-9-]{8,40}$/i.test(orderId)) return { ok: false, status: 400, error: "Invalid payment." };
  const { data: b } = await db.from("bookings").select("id").eq("payment_token", token).maybeSingle();
  if (!b) return { ok: false, status: 404, error: "We could not find that booking." };
  const { data: p } = await db.from("payments").select("*").eq("booking_id", b.id).eq("provider", "paypal").eq("provider_ref", orderId).maybeSingle();
  if (!p) return { ok: false, status: 404, error: "We could not find that payment." };
  if (p.paid_at) return { ok: true, status: "paid" };
  if (p.status !== "pending" && p.status !== "failed") return { ok: false, status: 409, error: "This payment attempt can no longer be completed. Please start again." };
  // The customer approving the payment in PayPal is their explicit confirmation of this booking's charge (recorded for the audit trail).
  await db.from("bookings").update({ customer_confirmed_at: new Date().toISOString() }).eq("id", b.id).is("customer_confirmed_at", null);

  const cap = await captureOrder(orderId, `cap-${p.id}`);
  if (!cap.ok) {
    await db.from("payments").update({ status: "failed", failure_reason: cap.error.slice(0, 300) }).eq("id", p.id);
    await syncBooking(db, b.id);
    return { ok: false, status: 402, error: "PayPal could not complete this payment. You have not been charged. Please try again or use another method." };
  }
  const v = verifyPayPalOrder(cap.order, { amountCents: p.amount_cents, currency: p.currency, bookingId: b.id, paymentId: p.id });
  if (!v.ok) {
    if (v.state === "mismatch") { await flagForReview(db, p, v.error, null); return { ok: false, status: 409, error: "We could not verify this payment. Our team will review it; please do not pay again." }; }
    await db.from("payments").update({ status: "failed", failure_reason: v.error.slice(0, 300) }).eq("id", p.id);
    await syncBooking(db, b.id);
    return { ok: false, status: 402, error: "PayPal did not complete this payment. You have not been charged." };
  }
  if (v.state === "pending") { await db.from("payments").update({ provider_txn_id: v.captureId, status: "pending" }).eq("id", p.id); return { ok: true, status: "pending" }; }
  await recordPaid(db, p, v.captureId);
  return { ok: true, status: "paid" };
}

// ---------------------------------------------------------------- Event processing (Stripe + PayPal webhooks)
interface Evt { id: string; type: string; data?: { object: Row }; resource?: Row }

async function once(db: SupabaseClient, table: "stripe_events" | "paypal_events", ev: Evt, run: () => Promise<void>): Promise<"processed" | "duplicate"> {
  const ins = await db.from(table).insert({ id: ev.id, type: ev.type });
  if (ins.error) {
    if (ins.error.code === "23505") return "duplicate";
    throw new Error("could not record event");
  }
  try {
    await run();
    return "processed";
  } catch (e) {
    await db.from(table).delete().eq("id", ev.id); // release so the provider's retry can run again
    throw e;
  }
}

async function findStripePayment(db: SupabaseClient, o: Row) {
  if (o.object === "checkout.session" || String(o.id ?? "").startsWith("cs_")) {
    const r = await db.from("payments").select("*").eq("stripe_session_id", o.id).maybeSingle();
    if (r.data) return r.data;
    if (o.metadata?.payment_id) return (await db.from("payments").select("*").eq("id", o.metadata.payment_id).maybeSingle()).data;
    return null;
  }
  if (o.object === "payment_intent") {
    const r = await db.from("payments").select("*").eq("stripe_payment_intent_id", o.id).maybeSingle();
    if (r.data) return r.data;
    if (o.metadata?.payment_id) return (await db.from("payments").select("*").eq("id", o.metadata.payment_id).maybeSingle()).data;
    return null;
  }
  if (o.payment_intent) return (await db.from("payments").select("*").eq("stripe_payment_intent_id", o.payment_intent).maybeSingle()).data;
  return null;
}

async function applyStripe(db: SupabaseClient, ev: Evt) {
  const o = ev.data!.object;
  // Saved-card events (a card saved at booking, and charges of that saved card) belong to saved-card.ts, which returns true when the event was its own.
  if (await onSavedCardEvent(db, ev.type, o)) return;
  switch (ev.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const p = await findStripePayment(db, o);
      // Authorize-now sessions finish as "unpaid" (the card is only held). Remember the PaymentIntent; the hold itself is recorded by
      // payment_intent.amount_capturable_updated. This NEVER marks anything paid.
      if (p && p.manual_capture && !p.paid_at && o.payment_intent && !p.stripe_payment_intent_id) { await db.from("payments").update({ stripe_payment_intent_id: String(o.payment_intent) }).eq("id", p.id); return; }
      if (!p || p.paid_at || o.payment_status !== "paid") return; // unpaid = delayed method still processing
      const consistent = Number(o.amount_total) === p.amount_cents && String(o.currency ?? "").toLowerCase() === String(p.currency).toLowerCase() && o.metadata?.booking_id === p.booking_id;
      if (!consistent) return flagForReview(db, p, "Amount, currency or booking did not match.", o.payment_intent ?? null);
      return recordPaid(db, p, o.payment_intent ?? null);
    }
    case "checkout.session.async_payment_failed": {
      const p = await findStripePayment(db, o);
      if (!p || p.paid_at) return;
      await db.from("payments").update({ status: "failed", failure_reason: "Payment failed" }).eq("id", p.id);
      await syncBooking(db, p.booking_id);
      return;
    }
    case "checkout.session.expired": {
      const p = await findStripePayment(db, o);
      if (!p || p.paid_at || p.status !== "pending") return;
      await db.from("payments").update({ status: "expired" }).eq("id", p.id);
      await syncBooking(db, p.booking_id);
      return;
    }
    case "payment_intent.amount_capturable_updated": return onAuthorized(db, o);
    case "payment_intent.succeeded": return onCaptured(db, o);
    case "payment_intent.canceled": return onAuthorizationEnded(db, o, o.cancellation_reason === "automatic" ? "expired" : "released");
    case "charge.expired": return onAuthorizationEnded(db, o, "expired");
    case "payment_intent.payment_failed": return onAuthorizationFailed(db, o);
    case "charge.refunded": {
      const p = await findStripePayment(db, o);
      if (!p) return;
      const refunded = Math.min(Number(o.amount_refunded ?? 0), p.amount_cents);
      await db.from("payments").update({ refunded_cents: refunded, status: refunded >= p.amount_cents ? "refunded" : "partially_refunded" }).eq("id", p.id);
      await syncBooking(db, p.booking_id);
      return;
    }
  }
}

/** Processes a VERIFIED Stripe event exactly once (the event id is recorded first). */
export function processStripeEvent(db: SupabaseClient, ev: Evt) { return once(db, "stripe_events", ev, () => applyStripe(db, ev)); }

async function applyPayPal(db: SupabaseClient, ev: Evt) {
  const r = ev.resource ?? {};
  const orderId: string | undefined = r.supplementary_data?.related_ids?.order_id;
  switch (ev.type) {
    case "PAYMENT.CAPTURE.COMPLETED": {
      let p = orderId ? (await db.from("payments").select("*").eq("provider", "paypal").eq("provider_ref", orderId).maybeSingle()).data : null;
      if (!p && r.id) p = (await db.from("payments").select("*").eq("provider", "paypal").eq("provider_txn_id", r.id).maybeSingle()).data;
      if (!p || p.paid_at) return;
      const cents = decimalToCents(r.amount?.value);
      const consistent = cents === p.amount_cents && String(r.amount?.currency_code ?? "").toUpperCase() === String(p.currency).toUpperCase() && (!r.custom_id || r.custom_id === p.booking_id);
      if (!consistent) return flagForReview(db, p, "Amount, currency or booking did not match.", r.id ?? null);
      return recordPaid(db, p, r.id ?? null);
    }
    case "PAYMENT.CAPTURE.DENIED":
    case "PAYMENT.CAPTURE.DECLINED": {
      const p = orderId ? (await db.from("payments").select("*").eq("provider", "paypal").eq("provider_ref", orderId).maybeSingle()).data : null;
      if (!p || p.paid_at) return;
      await db.from("payments").update({ status: "failed", failure_reason: "Payment denied by PayPal" }).eq("id", p.id);
      await syncBooking(db, p.booking_id);
      return;
    }
    case "PAYMENT.CAPTURE.REFUNDED": {
      // The resource is the refund; its "up" link points at the original capture.
      const up = (r.links ?? []).find((l: Row) => l.rel === "up")?.href as string | undefined;
      const captureId = up?.split("/").pop();
      if (!captureId) return;
      const p = (await db.from("payments").select("*").eq("provider", "paypal").eq("provider_txn_id", captureId).maybeSingle()).data;
      const cents = decimalToCents(r.amount?.value);
      if (!p || cents === null) return;
      const refunded = Math.min(p.amount_cents, (p.refunded_cents ?? 0) + cents);
      await db.from("payments").update({ refunded_cents: refunded, status: refunded >= p.amount_cents ? "refunded" : "partially_refunded" }).eq("id", p.id);
      await syncBooking(db, p.booking_id);
      return;
    }
  }
}
/** Processes a VERIFIED PayPal webhook event exactly once. */
export function processPayPalEvent(db: SupabaseClient, ev: Evt) { return once(db, "paypal_events", ev, () => applyPayPal(db, ev)); }


// ---------------------------------------------------------------- Legacy "authorize now" holds (history only)
// The old hosted authorize-now / capture-on-approval flow no longer creates anything. These handlers only keep late webhook events for EXISTING
// holds and rows consistent. An admin approval releases a leftover hold; nothing here ever captures one.

export { adminAlert };
const capBefore = (pi: StripePI): { brand: string | null; last4: string | null; captureBefore: string | null } => {
  const c = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge.payment_method_details?.card : undefined;
  return { brand: c?.brand ?? null, last4: c?.last4 ?? null, captureBefore: c?.capture_before ? new Date(Number(c.capture_before) * 1000).toISOString() : null };
};


/** Verified: Stripe reports the card is held. Records the hold, its expiry and non-sensitive card details. Charges nothing. */
async function onAuthorized(db: SupabaseClient, o: Row) {
  const p = await findStripePayment(db, o);
  if (!p || !p.manual_capture || p.paid_at || !["pending", "authorized"].includes(p.status)) return; // a late or duplicate event never revives an ended payment
  const consistent = Number(o.amount_capturable) === p.amount_cents && String(o.currency ?? "").toLowerCase() === String(p.currency).toLowerCase() && o.metadata?.booking_id === p.booking_id;
  if (!consistent) return flagForReview(db, p, "Authorized amount, currency or booking did not match.", o.id ?? null);
  const live = await retrievePaymentIntent(String(o.id)); // the expiry time and card brand/last four live on Stripe's charge, not on the event
  const d = live.ok ? capBefore(live.pi) : { brand: null, last4: null, captureBefore: null };
  await db.from("payments").update({ status: "authorized", stripe_payment_intent_id: String(o.id), authorized_amount_cents: p.amount_cents, capture_before: d.captureBefore, card_brand: d.brand, card_last4: d.last4, last_error: null, failure_reason: null }).eq("id", p.id);
  await syncBooking(db, p.booking_id);
  await adminAlert(db, p.booking_id, "payment.authorized", "Card authorized", `A card hold of ${formatMoney(p.amount_cents, p.currency)} is in place. Approve the booking to capture it.`);
}

/** Verified capture (payment_intent.succeeded) for an authorize-now payment: the only webhook path that marks it paid. */
async function onCaptured(db: SupabaseClient, o: Row) {
  const p = await findStripePayment(db, o);
  if (!p || !p.manual_capture || p.paid_at) return;
  const consistent = Number(o.amount_received) === p.amount_cents && String(o.currency ?? "").toLowerCase() === String(p.currency).toLowerCase() && o.metadata?.booking_id === p.booking_id;
  if (!consistent) return flagForReview(db, p, "Captured amount, currency or booking did not match.", o.id ?? null);
  await db.from("payments").update({ captured_amount_cents: Number(o.amount_received) }).eq("id", p.id);
  return recordPaid(db, p, String(o.id));
}

/** The hold ended without a capture. "expired" = Stripe let it lapse; "released" = we cancelled it. Neither changes the booking status. */
async function onAuthorizationEnded(db: SupabaseClient, o: Row, kind: "expired" | "released") {
  const p = await findStripePayment(db, o.object === "charge" ? { ...o, payment_intent: o.payment_intent } : o);
  if (!p || !p.manual_capture || p.paid_at || !["pending", "authorized", "capture_pending", "capture_failed"].includes(p.status)) return;
  if (kind === "released") { await db.from("payments").update({ status: "canceled" }).eq("id", p.id); await syncBooking(db, p.booking_id); return; }
  await db.from("payments").update({ status: "authorization_expired", failure_reason: "The card authorization expired before it was captured.", last_error: "Authorization expired" }).eq("id", p.id);
  await syncBooking(db, p.booking_id);
  await adminAlert(db, p.booking_id, "payment.needs_payment", "Needs payment: authorization expired", "The card hold expired before capture. The booking is still active and unpaid. Contact the customer or send them a new payment link.");
}

async function onAuthorizationFailed(db: SupabaseClient, o: Row) {
  const p = await findStripePayment(db, o);
  if (!p || !p.manual_capture || p.paid_at || p.status !== "pending") return;
  await db.from("payments").update({ status: "failed", failure_reason: String(o.last_payment_error?.message ?? "Card authorization failed").slice(0, 300) }).eq("id", p.id);
  await syncBooking(db, p.booking_id);
}

/** Releases any held (uncaptured) authorization, for example when a booking is declined or cancelled. Best effort; never touches captured money. */
export async function releaseAuthorization(db: SupabaseClient, bookingId: string): Promise<void> {
  const { data: rows } = await db.from("payments").select("id,stripe_payment_intent_id").eq("booking_id", bookingId).eq("manual_capture", true).in("status", ["pending", "authorized", "capture_failed"]);
  for (const p of rows ?? []) {
    if (p.stripe_payment_intent_id) await cancelPaymentIntent(p.stripe_payment_intent_id);
    await db.from("payments").update({ status: "canceled" }).eq("id", p.id);
  }
  if (rows?.length) await syncBooking(db, bookingId);
}
