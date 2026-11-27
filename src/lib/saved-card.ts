import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBookingSettings } from "@/lib/policies";
import { paymentPlan } from "@/lib/payments";
import { availableProviders } from "@/lib/payment-providers";
import {
  cancelPaymentIntent, createCustomer, createSavedCardCharge, createSetupIntent, detachPaymentMethod, publishableKey, retrievePaymentIntent, retrieveSetupIntent,
  type StripePI,
} from "@/lib/stripe";
import { BOOKING_COLUMNS, adminAlert, chargeForBooking, flagForReview, recordPaid, syncBooking, validToken, type Row } from "@/lib/payments-core";
import { PAID_STATES, AWAITING_REVIEW, awaitingCustomerConfirmation, isTerminal, type BookingStatus } from "@/lib/booking-status";
import { CARD_SAVE_CONSENT_TEXT, CARD_CHARGE_CONSENT_VERSION, cardChargeConsentText } from "@/lib/card-consent";
import { normalizeTrackingCode } from "@/lib/tracking";
import { formatMoney } from "@/lib/pricing/engine";
import { sendBookingCreatedNotice } from "@/lib/booking-notices";

/**
 * Saved-card workflow (Stripe SetupIntent, then a customer-confirmed charge). The rules this file enforces:
 *
 *  1. SAVE: a SetupIntent saves the card for this ONE booking. No charge, no hold. Stripe.js sends the card number straight to Stripe; this server
 *     only ever sees Stripe object ids plus the brand and last four digits Stripe reports. The card counts as saved only after the SERVER has read the
 *     SetupIntent back from Stripe (never because the browser said so).
 *  2. APPROVE: an administrator approves (admin route only). That alone charges nothing and confirms nothing.
 *  3. CONFIRM: the customer explicitly confirms. Only then is a PaymentIntent created for the saved card, for the amount the SERVER calculated.
 *  4. VERIFY: a payment becomes "paid", and the booking "confirmed", only through recordPaid(), from Stripe's verified result (its own API reply, or a
 *     signature-verified webhook). Failed, incomplete or authentication-pending payments never confirm anything.
 *  5. ONE charge: a unique database index allows a single live charge attempt per booking, Stripe idempotency keys make retries return the same result,
 *     and every state change is a conditional update.
 */

export type CustomerCred = { kind: "token"; token: string } | { kind: "code"; code: string };

/** Reads the credential a customer request carries: the private booking token or the tracking ID. Anything else is not a credential. */
export function credentialFrom(body: Record<string, unknown> | null): CustomerCred | null {
  if (!body) return null;
  if (validToken(body.token)) return { kind: "token", token: body.token };
  const code = normalizeTrackingCode(body.trackingId);
  return code ? { kind: "code", code } : null;
}

const COLS = `${BOOKING_COLUMNS},tracking_code,pickup_at,card_consent_at,stripe_setup_intent_id`;
export async function bookingByCred(db: SupabaseClient, cred: CustomerCred): Promise<Row | null> {
  const q = db.from("bookings").select(COLS);
  const { data } = await (cred.kind === "token" ? q.eq("payment_token", cred.token) : q.eq("tracking_code", cred.code)).maybeSingle();
  return (data as Row | null) ?? null;
}

const NOT_FOUND = { ok: false as const, status: 404, code: "not_found", error: "We could not find that booking." };
const closed = (b: Row) => isTerminal(b.status as BookingStatus);
const stripeReady = (settings: Awaited<ReturnType<typeof loadBookingSettings>>) => availableProviders(settings).includes("stripe") && Boolean(publishableKey());

export type Fail = { ok: false; status: number; code: string; error: string };

// ================================================================ 1. SAVE THE CARD (SetupIntent)

export type SetupStart = { ok: true; clientSecret: string; publishableKey: string; currency: string } | Fail;

/**
 * Creates (or resumes) the SetupIntent for this booking and records the customer's consent to save the card. Safe to call repeatedly: an unfinished
 * SetupIntent is reused, so a refresh or a double click never produces a second one. Allowed while the booking awaits review, or after approval
 * (to replace a card that could not be charged). Charges nothing and holds nothing.
 */
export async function startCardSetup(db: SupabaseClient, cred: CustomerCred, consent: boolean): Promise<SetupStart> {
  const b = await bookingByCred(db, cred);
  if (!b) return NOT_FOUND;
  if (closed(b)) return { ok: false, status: 409, code: "closed", error: "This booking is no longer open. Please contact us if you have questions." };
  if (b.confirmed_at || PAID_STATES.includes(String(b.payment_status))) return { ok: false, status: 409, code: "already_confirmed", error: "This booking is already confirmed. Nothing more is needed." };
  const awaitingReview = AWAITING_REVIEW.includes(b.status as BookingStatus);
  if (!awaitingReview && !awaitingCustomerConfirmation(b as never)) return { ok: false, status: 409, code: "not_available", error: "A card cannot be added to this booking right now. Please contact us." };
  if (b.online_amount_cents == null) return { ok: false, status: 409, code: "no_online_amount", error: "An online amount has not been set for this booking. We will confirm the price and payment with you." };
  const settings = await loadBookingSettings(db);
  if (!stripeReady(settings)) return { ok: false, status: 503, code: "unavailable", error: "Card payment is not available right now. Your booking is saved; we will contact you about payment." };
  if (consent !== true) return { ok: false, status: 422, code: "consent_required", error: "Please tick the box to allow us to save your card for this booking." };

  // A charge waiting for the customer's bank is abandoned when they choose a different card; one that is processing must finish first.
  const { data: live } = await db.from("payments").select("id,status,stripe_payment_intent_id").eq("booking_id", b.id).eq("saved_card", true).in("status", ["processing", "requires_action"]);
  if ((live ?? []).some((p: Row) => p.status === "processing")) return { ok: false, status: 409, code: "in_progress", error: "A payment for this booking is being processed. Please wait a moment and refresh." };
  for (const p of live ?? []) {
    if (p.stripe_payment_intent_id) await cancelPaymentIntent(p.stripe_payment_intent_id);
    await db.from("payments").update({ status: "canceled", failure_reason: "Replaced by a different card" }).eq("id", p.id).is("paid_at", null);
  }
  if (live?.length) await syncBooking(db, b.id);

  // Stripe customer for this booking (one per booking: the card is saved for THIS booking only).
  let customerId: string = b.stripe_customer_id ?? "";
  if (!customerId) {
    const { data: c } = await db.from("customers").select("name,email").eq("id", b.customer_id).maybeSingle();
    const made = await createCustomer({ email: c?.email ?? undefined, name: c?.name ?? undefined, bookingId: b.id, idempotencyKey: `cust-${b.id}` });
    if (!made.ok) { console.error("[card] customer failed", made.code); return { ok: false, status: 502, code: "stripe_error", error: "We could not open the secure card form. You have not been charged. Please try again in a moment." }; }
    const set = await db.from("bookings").update({ stripe_customer_id: made.id }).eq("id", b.id).is("stripe_customer_id", null).select("id");
    customerId = set.data?.length ? made.id : ((await db.from("bookings").select("stripe_customer_id").eq("id", b.id).maybeSingle()).data?.stripe_customer_id ?? made.id);
  }

  // Reuse the unfinished SetupIntent when there is one that belongs to this booking and customer.
  const prevId: string | null = b.stripe_setup_intent_id ?? null;
  if (prevId) {
    const prev = await retrieveSetupIntent(prevId);
    if (prev.ok && prev.si.metadata?.booking_id === b.id && prev.si.customer === customerId && ["requires_payment_method", "requires_confirmation", "requires_action"].includes(prev.si.status) && prev.si.client_secret) {
      return { ok: true, clientSecret: prev.si.client_secret, publishableKey: publishableKey(), currency: String(b.currency ?? "USD").toLowerCase() };
    }
  }
  const made = await createSetupIntent({ customerId, bookingId: b.id, idempotencyKey: `setup-${b.id}-${prevId ?? "first"}` });
  if (!made.ok || !made.si.client_secret) { console.error("[card] setup intent failed", made.ok ? "no client secret" : made.code); return { ok: false, status: 502, code: "stripe_error", error: "We could not open the secure card form. You have not been charged. Please try again in a moment." }; }
  const now = new Date().toISOString();
  const claim = prevId
    ? await db.from("bookings").update({ stripe_setup_intent_id: made.si.id, card_consent_at: now, card_consent_text: CARD_SAVE_CONSENT_TEXT }).eq("id", b.id).eq("stripe_setup_intent_id", prevId).select("id")
    : await db.from("bookings").update({ stripe_setup_intent_id: made.si.id, card_consent_at: now, card_consent_text: CARD_SAVE_CONSENT_TEXT }).eq("id", b.id).is("stripe_setup_intent_id", null).select("id");
  if (!claim.data?.length) {
    // Another tab or request won: use the SetupIntent it stored, so both end up on the SAME one.
    const cur = (await db.from("bookings").select("stripe_setup_intent_id").eq("id", b.id).maybeSingle()).data?.stripe_setup_intent_id;
    const same = cur ? await retrieveSetupIntent(cur) : null;
    if (same?.ok && same.si.client_secret) return { ok: true, clientSecret: same.si.client_secret, publishableKey: publishableKey(), currency: String(b.currency ?? "USD").toLowerCase() };
  }
  return { ok: true, clientSecret: made.si.client_secret, publishableKey: publishableKey(), currency: String(b.currency ?? "USD").toLowerCase() };
}

export type FinalizeSetup = { ok: true; first: boolean; brand: string | null; last4: string | null } | Fail;

/**
 * Marks the card as saved ONLY after reading the SetupIntent back from Stripe and checking it: it succeeded, belongs to this booking and customer,
 * and is the booking's current SetupIntent. Idempotent: the browser callback and the setup_intent.succeeded webhook may both call it, in any order.
 * The first completion finishes the booking request (admin alert and customer email), exactly once.
 */
export async function finalizeCardSetup(db: SupabaseClient, bookingId: string, setupIntentId?: string): Promise<FinalizeSetup> {
  const { data: b } = await db.from("bookings").select(COLS).eq("id", bookingId).maybeSingle();
  if (!b) return NOT_FOUND;
  const siId = setupIntentId ?? b.stripe_setup_intent_id;
  if (!siId || siId !== b.stripe_setup_intent_id) return { ok: false, status: 409, code: "stale", error: "That card form is out of date. Please reload the page and try again." };
  const r = await retrieveSetupIntent(siId);
  if (!r.ok) return { ok: false, status: 502, code: "stripe_error", error: "We could not check your card with Stripe. You have not been charged. Please try again." };
  const si = r.si;
  if (si.metadata?.booking_id !== b.id || (b.stripe_customer_id && si.customer !== b.stripe_customer_id)) return { ok: false, status: 409, code: "mismatch", error: "We could not match that card to this booking." };
  if (si.status !== "succeeded") return { ok: false, status: 409, code: si.status, error: si.status === "processing" ? "Your bank is still checking your card. This page updates when it is done." : "Your card was not saved. You have not been charged. Please try again." };
  const pm = si.payment_method && typeof si.payment_method === "object" ? si.payment_method : null;
  const pmId = pm?.id ?? (typeof si.payment_method === "string" ? si.payment_method : null);
  if (!pmId || (pm && b.stripe_customer_id && pm.customer && pm.customer !== b.stripe_customer_id)) return { ok: false, status: 409, code: "mismatch", error: "We could not match that card to this booking." };
  const brand = pm?.card?.brand ?? null; const last4 = pm?.card?.last4 ?? null;
  const first = !b.card_setup_at;
  const now = new Date().toISOString();
  const fields = { stripe_payment_method_id: pmId, card_brand: brand, card_last4: last4, card_setup_at: now };
  if (first) {
    const won = await db.from("bookings").update(fields).eq("id", b.id).is("card_setup_at", null).select("id");
    if (won.error) return { ok: false, status: 500, code: "db", error: "We could not save your card details. You have not been charged. Please try again." };
    if (!won.data?.length) return { ok: true, first: false, brand, last4 }; // another delivery finished it first
  } else if (b.stripe_payment_method_id !== pmId) {
    // The customer replaced their card (for example after a decline). Only while nothing has been charged or confirmed.
    if (b.confirmed_at || PAID_STATES.includes(String(b.payment_status))) return { ok: false, status: 409, code: "already_confirmed", error: "This booking is already confirmed." };
    const upd = await db.from("bookings").update(fields).eq("id", b.id).eq("stripe_payment_method_id", b.stripe_payment_method_id).select("id");
    if (!upd.data?.length) return { ok: true, first: false, brand, last4 };
    if (b.stripe_payment_method_id) await detachPaymentMethod(b.stripe_payment_method_id);
  } else {
    return { ok: true, first: false, brand, last4 };
  }
  await syncBooking(db, b.id);
  await db.from("activity_logs").insert({ action: "booking.card_saved", entity_type: "booking", entity_id: b.id, meta: { brand, last4, replaced: !first, charged: false, held: false } });
  await db.from("booking_status_history").insert({ booking_id: b.id, from_status: b.status, to_status: b.status, actor_type: "customer", actor_id: null, note: `${first ? "Card saved" : "Card replaced"}${last4 ? ` (${(brand ?? "card").toUpperCase()} ending ${last4})` : ""}. Nothing was charged and no funds are held.` });
  if (first) await sendBookingCreatedNotice(db, b.id); // the request is complete now: tell the business and the customer, once
  return { ok: true, first, brand, last4 };
}

/** The browser reports that card entry finished. The server verifies it with Stripe (the report itself proves nothing). */
export async function completeCardSetup(db: SupabaseClient, cred: CustomerCred): Promise<FinalizeSetup> {
  const b = await bookingByCred(db, cred);
  if (!b) return NOT_FOUND;
  return finalizeCardSetup(db, b.id);
}

// ================================================================ 3. CUSTOMER CONFIRMS -> CHARGE THE SAVED CARD

export type ChargeOutcome =
  | { ok: true; state: "paid" }
  | { ok: true; state: "processing"; message: string }
  | { ok: true; state: "requires_action"; clientSecret: string }
  | Fail;

const DECLINE_TEXT: Record<string, string> = {
  insufficient_funds: "Your card has insufficient funds.", expired_card: "Your card has expired.", incorrect_cvc: "The card security code was not accepted.",
  card_declined: "Your card was declined.", processing_error: "Your bank could not process the payment.", lost_card: "Your card was declined.", stolen_card: "Your card was declined.",
};
const declineText = (code?: string | null) => `${(code && DECLINE_TEXT[code]) || "Your card was declined."} You have not been charged. Please try again or use a different card.`;

const totalLabel = (cents: number, currency: string) => formatMoney(cents, currency);

/** Does Stripe's PaymentIntent match the payment row and booking we expect? Anything else is never marked paid. */
function piMatches(pi: StripePI, p: Row, b: Row): boolean {
  return pi.amount === p.amount_cents && String(pi.currency).toLowerCase() === String(p.currency).toLowerCase() && pi.metadata?.booking_id === b.id && pi.metadata?.payment_id === p.id
    && (!b.stripe_customer_id || pi.customer === b.stripe_customer_id);
}

async function failAttempt(db: SupabaseClient, p: Row, b: Row, reason: string, piId?: string | null): Promise<Fail> {
  const upd = await db.from("payments").update({ status: "failed", failure_reason: reason.slice(0, 300), last_error: reason.slice(0, 300), ...(piId ? { stripe_payment_intent_id: piId } : {}) }).eq("id", p.id).is("paid_at", null).in("status", ["processing", "requires_action"]).select("id");
  await syncBooking(db, b.id);
  if (upd.data?.length) await adminAlert(db, b.id, "payment.failed", "Card payment failed", "The customer's saved card could not be charged. The booking stays approved and NOT confirmed or paid; the customer can retry or use another card.");
  return { ok: false, status: 402, code: "payment_failed", error: reason };
}

/** Turns a Stripe PaymentIntent into an outcome and the matching stored state. Never marks anything paid except through recordPaid() on a verified success. */
async function applyIntent(db: SupabaseClient, p: Row, b: Row, pi: StripePI): Promise<ChargeOutcome> {
  if (!piMatches(pi, p, b)) { await flagForReview(db, p, "Stripe's payment does not match this booking.", pi.id); return { ok: false, status: 409, code: "mismatch", error: "We could not verify this payment. Our team will review it; please do not try again." }; }
  if (!p.stripe_payment_intent_id) await db.from("payments").update({ stripe_payment_intent_id: pi.id }).eq("id", p.id).is("paid_at", null);
  switch (pi.status) {
    case "succeeded": {
      if (Number(pi.amount_received) !== p.amount_cents) { await flagForReview(db, p, "Charged amount did not match.", pi.id); return { ok: false, status: 409, code: "mismatch", error: "We could not verify this payment. Our team will review it; please do not try again." }; }
      await recordPaid(db, { ...p, saved_card: true }, pi.id);
      return { ok: true, state: "paid" };
    }
    case "requires_action": {
      if (!pi.client_secret) return { ok: true, state: "processing", message: "Your payment is waiting for your bank. Please refresh this page in a moment." };
      await db.from("payments").update({ status: "requires_action", stripe_payment_intent_id: pi.id }).eq("id", p.id).is("paid_at", null).in("status", ["processing", "requires_action"]);
      await syncBooking(db, b.id);
      return { ok: true, state: "requires_action", clientSecret: pi.client_secret };
    }
    case "processing":
      await db.from("payments").update({ status: "processing", stripe_payment_intent_id: pi.id }).eq("id", p.id).is("paid_at", null).in("status", ["processing", "requires_action"]);
      await syncBooking(db, b.id);
      return { ok: true, state: "processing", message: "Your payment is processing. This page updates when your bank confirms it. Please do not pay again." };
    case "requires_payment_method":
    case "canceled":
      return failAttempt(db, p, b, declineText(pi.last_payment_error?.decline_code ?? pi.last_payment_error?.code), pi.id);
    default:
      return { ok: true, state: "processing", message: "Your payment is being checked. Please refresh this page in a moment." };
  }
}

/** Resumes a charge attempt that is already live (a double click, a second tab, a return from the bank, a retry after a network error). */
async function resumeAttempt(db: SupabaseClient, b: Row, p: Row, siteUrl: string): Promise<ChargeOutcome> {
  if (p.stripe_payment_intent_id) {
    const r = await retrievePaymentIntent(p.stripe_payment_intent_id);
    if (!r.ok) return { ok: true, state: "processing", message: "We could not reach Stripe to check your payment just now. You have not been charged twice; please refresh this page in a moment." };
    return applyIntent(db, p, b, r.pi);
  }
  // The earlier request did not learn the outcome (for example a network error). Repeating it with the SAME idempotency key returns Stripe's original result: never a second charge.
  return submitCharge(db, b, p, siteUrl);
}

async function submitCharge(db: SupabaseClient, b: Row, p: Row, siteUrl: string): Promise<ChargeOutcome> {
  const res = await createSavedCardCharge({
    amountCents: p.amount_cents, currency: p.currency, customerId: b.stripe_customer_id, paymentMethodId: b.stripe_payment_method_id, bookingId: b.id, paymentId: p.id,
    returnUrl: `${siteUrl}/book/confirmation?t=${encodeURIComponent(String(b.payment_token))}&charge=return`, description: `Vanta Transportation booking ${b.reference}`, idempotencyKey: `charge-${p.id}`,
  });
  if (!res.ok) {
    if (res.pi && res.pi.status === "requires_action") return applyIntent(db, p, b, res.pi);
    // Only a real card/payment error is a failure. A dropped connection, a Stripe outage, a rate limit or an idempotency-key collision (a concurrent request is
    // already creating this very charge) says nothing about the card: the attempt stays live, and a retry with the SAME key returns Stripe's original result.
    const isCardFailure = Boolean(res.pi) || /declin|card|expired|cvc|cvv|funds|incorrect|invalid_(number|expiry)|authentication_required|processing_error/i.test(res.code);
    if (!isCardFailure) return { ok: true, state: "processing", message: "We could not confirm the result with Stripe just now. You have not been charged twice; please refresh this page in a moment." };
    return failAttempt(db, p, b, declineText(res.code), res.pi?.id ?? null);
  }
  return applyIntent(db, p, b, res.pi);
}

/**
 * The customer's explicit "Confirm Booking & Authorize Charge". Verifies on the SERVER, in this order: the booking is theirs, an admin approved it,
 * it is not already confirmed/closed, the consent was given, a usable saved card belongs to this booking, and the amount (recalculated from the
 * database, never taken from the browser) is due. Only then is the saved card charged, once.
 */
export async function confirmAndCharge(db: SupabaseClient, cred: CustomerCred, consent: boolean, siteUrl: string): Promise<ChargeOutcome> {
  const b = await bookingByCred(db, cred);
  if (!b) return NOT_FOUND;
  if (closed(b)) return { ok: false, status: 409, code: "closed", error: "This booking is no longer open for confirmation. Please contact us if you have questions." };
  if (b.confirmed_at || PAID_STATES.includes(String(b.payment_status))) return { ok: true, state: "paid" }; // a repeat click on an already confirmed booking changes nothing
  if (!awaitingCustomerConfirmation(b as never)) return { ok: false, status: 409, code: "not_approved", error: "This booking has not been approved yet, so it cannot be confirmed. You have not been charged." };
  if (consent !== true) return { ok: false, status: 422, code: "consent_required", error: "Please tick the box to confirm your booking and authorize the charge." };
  const settings = await loadBookingSettings(db);
  if (!availableProviders(settings).includes("stripe")) return { ok: false, status: 503, code: "unavailable", error: "Card payment is not available right now. Please contact us. You have not been charged." };
  if (!b.stripe_customer_id || !b.stripe_payment_method_id || !b.card_setup_at) return { ok: false, status: 409, code: "card_required", error: "Please add a card first. You have not been charged." };
  const c = await chargeForBooking(db, b);
  if (!c.ok) return { ok: false, status: 409, code: "no_amount", error: c.error };
  // This workflow charges the COMPLETE approved total, whatever the deposit setting says; the amount is the server's, never the browser's.
  const plan = paymentPlan({ ...settings.payment, mode: "full" }, c.charge.totalCents, b.amount_paid_cents ?? 0);
  if (!plan) return { ok: false, status: 409, code: "nothing_due", error: "There is nothing to pay online for this booking right now." };

  const { data: rows } = await db.from("payments").select("*").eq("booking_id", b.id).eq("saved_card", true).order("created_at", { ascending: false });
  const live = (rows ?? []).find((r: Row) => ["processing", "requires_action"].includes(r.status));
  if (live) return resumeAttempt(db, b, live, siteUrl);

  // Record the explicit confirmation (the latest one wins) before any money moves.
  const now = new Date().toISOString();
  await db.from("bookings").update({ customer_confirmed_at: now }).eq("id", b.id);
  await db.from("activity_logs").insert({ action: "booking.customer_confirmed", entity_type: "booking", entity_id: b.id, meta: { amountCents: plan.amountCents, consentVersion: CARD_CHARGE_CONSENT_VERSION, consentText: cardChargeConsentText(totalLabel(plan.amountCents, b.currency ?? "USD")), card: b.card_last4 ?? null } });
  await db.from("booking_status_history").insert({ booking_id: b.id, from_status: b.status, to_status: b.status, actor_type: "customer", actor_id: null, note: `Customer confirmed the booking and authorized a charge of ${totalLabel(plan.amountCents, b.currency ?? "USD")}` });

  const currency = b.currency ?? "USD";
  const ins = await db.from("payments").insert({
    booking_id: b.id, provider: "stripe", amount_cents: plan.amountCents, currency, kind: plan.kind, status: "processing", saved_card: true, manual_capture: false, stripe_payment_method_id: b.stripe_payment_method_id,
    card_brand: b.card_brand ?? null, card_last4: b.card_last4 ?? null,
    tier_id: c.charge.tierId, tier_name: c.charge.tierName, fixed_price_cents: c.charge.fixedPriceCents, meet_greet_cents: c.charge.meetGreetCents,
    other_addons_cents: c.charge.addonsCents, estimated_trip_fare_cents: c.charge.tripEstimateCents,
  }).select("*").single();
  if (ins.error || !ins.data) {
    if (ins.error?.code === "23505") { // a concurrent request created the single live attempt: join it, never add a second
      const { data: again } = await db.from("payments").select("*").eq("booking_id", b.id).eq("saved_card", true).in("status", ["processing", "requires_action"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (again) return resumeAttempt(db, b, again, siteUrl);
    }
    return { ok: false, status: 500, code: "db", error: "We could not start the payment. You have not been charged. Please try again." };
  }
  await syncBooking(db, b.id);
  return submitCharge(db, { ...b, customer_confirmed_at: now }, ins.data, siteUrl);
}

/** After the customer completes their bank's authentication (or returns from it), or to refresh a payment that was processing: re-check with Stripe. */
export async function finalizeCharge(db: SupabaseClient, cred: CustomerCred, siteUrl: string): Promise<ChargeOutcome> {
  const b = await bookingByCred(db, cred);
  if (!b) return NOT_FOUND;
  if (b.confirmed_at || PAID_STATES.includes(String(b.payment_status))) return { ok: true, state: "paid" };
  const { data: rows } = await db.from("payments").select("*").eq("booking_id", b.id).eq("saved_card", true).order("created_at", { ascending: false });
  const latest = (rows ?? [])[0] as Row | undefined;
  if (!latest) return { ok: false, status: 409, code: "no_payment", error: "There is no payment in progress for this booking." };
  if (["processing", "requires_action"].includes(latest.status)) return resumeAttempt(db, b, latest, siteUrl);
  if (latest.status === "failed") return { ok: false, status: 402, code: "payment_failed", error: latest.failure_reason ?? declineText() };
  return { ok: false, status: 409, code: "no_payment", error: "There is no payment in progress for this booking." };
}

// ================================================================ cleanup when a booking is declined or cancelled

/** Best effort: removes an unused saved card from Stripe when the booking is declined or cancelled uncharged. Never touches money. */
export async function releaseSavedCard(db: SupabaseClient, bookingId: string): Promise<void> {
  const { data: b } = await db.from("bookings").select("stripe_payment_method_id,payment_status,confirmed_at").eq("id", bookingId).maybeSingle();
  if (!b?.stripe_payment_method_id || b.confirmed_at || PAID_STATES.includes(String(b.payment_status))) return;
  // A charge that is mid-flight is left alone.
  const { data: live } = await db.from("payments").select("id").eq("booking_id", bookingId).eq("saved_card", true).in("status", ["processing", "requires_action"]);
  if (live?.length) return;
  await detachPaymentMethod(b.stripe_payment_method_id);
  await db.from("bookings").update({ stripe_payment_method_id: null }).eq("id", bookingId);
}

// ================================================================ webhooks

async function paymentFor(db: SupabaseClient, o: Row): Promise<Row | null> {
  const byIntent = await db.from("payments").select("*").eq("stripe_payment_intent_id", o.id).maybeSingle();
  if (byIntent.data) return byIntent.data as Row;
  // The event can arrive before our own request stored the PaymentIntent id: the metadata we set at creation identifies the payment row.
  if (typeof o.metadata?.payment_id === "string" && validToken(o.metadata.payment_id)) return ((await db.from("payments").select("*").eq("id", o.metadata.payment_id).maybeSingle()).data as Row | null) ?? null;
  return null;
}

const LIVE = ["processing", "requires_action"];

/**
 * Handles verified Stripe events about a saved card or a charge of one. Returns true when the event was ours (so the legacy handlers skip it).
 * Safe against duplicates and out-of-order delivery: every update is conditional on the payment still being live and unpaid, so a late
 * "processing" or "failed" event can never undo a payment that already succeeded, and nothing is "paid" without an amount/currency/booking match.
 */
export async function onSavedCardEvent(db: SupabaseClient, type: string, o: Row): Promise<boolean> {
  if (type === "setup_intent.succeeded" || type === "setup_intent.setup_failed") {
    const byMeta = typeof o.metadata?.booking_id === "string" && validToken(o.metadata.booking_id) ? o.metadata.booking_id : null;
    const b = byMeta ? { id: byMeta } : (await db.from("bookings").select("id").eq("stripe_setup_intent_id", o.id).maybeSingle()).data;
    if (!b) return true; // not one of ours: nothing to do
    if (type === "setup_intent.succeeded") await finalizeCardSetup(db, b.id, String(o.id)); // verifies with Stripe again; stale or foreign intents are ignored
    return true;
  }
  if (!type.startsWith("payment_intent.")) return false;
  const p = await paymentFor(db, o);
  if (!p || p.saved_card !== true) return false;
  const bookingId: string = p.booking_id;
  if (p.paid_at) return true; // already recorded: duplicates and late events change nothing
  switch (type) {
    case "payment_intent.succeeded": {
      const { data: b } = await db.from("bookings").select("id,stripe_customer_id").eq("id", bookingId).maybeSingle();
      const ok = b && Number(o.amount_received) === p.amount_cents && String(o.currency ?? "").toLowerCase() === String(p.currency).toLowerCase() && o.metadata?.booking_id === bookingId && o.metadata?.payment_id === p.id && (!b.stripe_customer_id || o.customer === b.stripe_customer_id);
      if (!ok) { await flagForReview(db, p, "Charged amount, currency or booking did not match.", o.id ?? null); return true; }
      await recordPaid(db, p, String(o.id));
      return true;
    }
    case "payment_intent.processing":
      await db.from("payments").update({ status: "processing", stripe_payment_intent_id: String(o.id) }).eq("id", p.id).is("paid_at", null).in("status", LIVE);
      await syncBooking(db, bookingId);
      return true;
    case "payment_intent.requires_action":
      await db.from("payments").update({ status: "requires_action", stripe_payment_intent_id: String(o.id) }).eq("id", p.id).is("paid_at", null).in("status", LIVE);
      await syncBooking(db, bookingId);
      return true;
    case "payment_intent.payment_failed":
    case "payment_intent.canceled": {
      const reason = type === "payment_intent.canceled" ? "The payment was cancelled." : declineText(o.last_payment_error?.decline_code ?? o.last_payment_error?.code);
      const upd = await db.from("payments").update({ status: "failed", failure_reason: reason, last_error: reason, stripe_payment_intent_id: String(o.id) }).eq("id", p.id).is("paid_at", null).in("status", LIVE).select("id");
      await syncBooking(db, bookingId);
      if (upd.data?.length) await adminAlert(db, bookingId, "payment.failed", "Card payment failed", "The customer's saved card could not be charged. The booking stays approved and NOT confirmed or paid; the customer can retry or use another card.");
      return true;
    }
  }
  return false;
}
