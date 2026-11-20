import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBookingSettings } from "@/lib/policies";
import { decimalToCents, paymentPlan, statusAfterPayment } from "@/lib/payments";
import { createCheckoutSession, expireCheckoutSession } from "@/lib/stripe";
import { captureOrder, createOrder } from "@/lib/paypal";
import { verifyPayPalOrder } from "@/lib/paypal-verify";
import { availableProviders, type Provider } from "@/lib/payment-providers";
import { CHARGE_REASON_TEXT, onlineCharge, type OnlineCharge } from "@/lib/tier-pricing";
import { notify } from "@/lib/notify";
import { formatMoney } from "@/lib/pricing/engine";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validToken = (t: unknown): t is string => typeof t === "string" && UUID_RE.test(t);
export type { Provider };

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type CheckoutOutcome =
  | { ok: true; provider: "stripe"; url: string }
  | { ok: true; provider: "paypal"; orderId: string }
  | { ok: false; status: number; error: string };

/**
 * The ONLINE charge for a booking, always from trusted data and never from the browser:
 *   fixed price of the booking's tier + Meet & Greet (if it was selected) + child seats.
 * Mileage, hourly, duration and toll amounts are not part of it. The tier price and fees are the snapshot frozen when the
 * booking was requested, so later admin changes never rewrite them. Bookings that pre-date the snapshot are priced once
 * from the tier's current configuration and then frozen.
 */
export async function chargeForBooking(db: SupabaseClient, b: Row): Promise<{ ok: true; charge: OnlineCharge } | { ok: false; error: string }> {
  if (b.online_amount_cents != null && b.fixed_price_cents != null) {
    const mg = b.meet_greet_selected ? b.meet_greet_fee_cents : 0;
    if (b.meet_greet_selected && (mg == null || mg <= 0)) return { ok: false, error: "The Meet & Greet fee for this booking is missing. Please contact us." };
    const addons = b.child_seat_fee_cents ?? 0;
    const rush = b.rush_surcharge_cents ?? 0, tip = b.tip_cents ?? 0;
    const total = b.fixed_price_cents + rush + tip + (mg ?? 0) + addons;
    if (total !== b.online_amount_cents) return { ok: false, error: "The saved amount for this booking is inconsistent. Please contact us." };
    return { ok: true, charge: { tierId: b.tier_id ?? null, tierName: b.tier_name ?? "", fixedPriceCents: b.fixed_price_cents, meetGreetCents: mg ?? 0, addonsCents: addons, rushCents: rush, tipCents: tip, totalCents: total } };
  }
  if (!b.tier_id) return { ok: false, error: "Online payment is not available for this booking. We will arrange payment with you directly." };
  const { data: t } = await db.from("vehicle_tiers").select("id,name,fixed_price_cents,meet_greet_fee_cents").eq("id", b.tier_id).maybeSingle();
  const r = onlineCharge(t ? { id: t.id, name: t.name, fixedPriceCents: t.fixed_price_cents ?? null, meetGreetFeeCents: t.meet_greet_fee_cents ?? null } : null, { meetGreet: Boolean(b.meet_greet_selected), addonsCents: b.child_seat_fee_cents ?? 0, rushCents: b.rush_surcharge_cents ?? 0, tipCents: b.tip_cents ?? 0 });
  if (!r.ok) return { ok: false, error: r.reason === "price_not_set" ? "Online payment is not available for this booking yet." : CHARGE_REASON_TEXT[r.reason] };
  await db.from("bookings").update({ tier_name: r.charge.tierName, fixed_price_cents: r.charge.fixedPriceCents, meet_greet_fee_cents: b.meet_greet_selected ? r.charge.meetGreetCents : null, online_amount_cents: r.charge.totalCents }).eq("id", b.id);
  return r;
}

const BOOKING_COLUMNS = "id,reference,status,driver_id,approved_at,payment_released_at,rush_surcharge_cents,tip_cents,currency,estimated_fare_cents,amount_paid_cents,customer_id,tier_id,tier_name,fixed_price_cents,meet_greet_selected,meet_greet_fee_cents,child_seat_fee_cents,online_amount_cents";

/**
 * Starts a payment with the chosen provider. The amount is recalculated here from the database; the only things the
 * browser supplies are the private booking token and which provider it wants.
 */
export async function startCheckout(db: SupabaseClient, token: string, provider: Provider, siteUrl: string): Promise<CheckoutOutcome> {
  const { data: b } = await db.from("bookings").select(BOOKING_COLUMNS).eq("payment_token", token).maybeSingle();
  if (!b) return { ok: false, status: 404, error: "We could not find that booking." };
  if (b.status === "cancelled" || b.status === "no_show") return { ok: false, status: 409, error: "This booking can no longer be paid online. Please contact us." };
  // Approve-then-pay: no payment session exists until an admin has approved the booking AND assigned a driver.
  if (!b.payment_released_at || !b.driver_id) return { ok: false, status: 409, error: "Your request is still being reviewed. We will email you a payment link once your booking is approved and a driver is assigned." };
  const settings = await loadBookingSettings(db);
  if (!availableProviders(settings).includes(provider)) {
    return { ok: false, status: 503, error: `${provider === "stripe" ? "Card payment" : "PayPal"} is not available right now. Please choose another way to pay, or contact us.` };
  }
  const c = await chargeForBooking(db, b);
  if (!c.ok) return { ok: false, status: 409, error: c.error };
  const { charge } = c;
  const plan = paymentPlan(settings.payment, charge.totalCents, b.amount_paid_cents ?? 0);
  if (!plan) return { ok: false, status: 409, error: "There is nothing to pay online for this booking right now." };

  // Retire any earlier unpaid attempt so the customer cannot pay twice.
  const { data: open } = await db.from("payments").select("id,provider,provider_ref").eq("booking_id", b.id).eq("status", "pending");
  for (const p of open ?? []) {
    if (p.provider === "stripe" && p.provider_ref) await expireCheckoutSession(p.provider_ref);
    await db.from("payments").update({ status: "expired" }).eq("id", p.id);
  }

  const currency = b.currency ?? "USD";
  const ins = await db.from("payments").insert({
    booking_id: b.id, provider, amount_cents: plan.amountCents, currency, kind: plan.kind, status: "pending",
    tier_id: charge.tierId, tier_name: charge.tierName, fixed_price_cents: charge.fixedPriceCents, meet_greet_cents: charge.meetGreetCents,
    other_addons_cents: charge.addonsCents, estimated_trip_fare_cents: b.estimated_fare_cents ?? null,
  }).select("id").single();
  if (ins.error) return { ok: false, status: 500, error: "Could not start the payment. Please try again." };
  const paymentId: string = ins.data.id;

  // Line items shown to the customer by the provider. A deposit is a single line.
  const full = plan.amountCents === charge.totalCents;
  const lines = full
    ? [{ name: `Fixed ${charge.tierName} price (${b.reference})`, amountCents: charge.fixedPriceCents }, ...(charge.rushCents > 0 ? [{ name: "Rush-hour surcharge", amountCents: charge.rushCents }] : []), ...(charge.tipCents > 0 ? [{ name: "Driver tip", amountCents: charge.tipCents }] : []), ...(charge.meetGreetCents > 0 ? [{ name: "Airport Meet & Greet", amountCents: charge.meetGreetCents }] : []), ...(charge.addonsCents > 0 ? [{ name: "Child car seats", amountCents: charge.addonsCents }] : [])]
    : [{ name: `Deposit for booking ${b.reference}`, amountCents: plan.amountCents }];
  const fail = async (error: string, status: number): Promise<CheckoutOutcome> => {
    console.error(`[payments] ${provider} checkout failed`, error);
    await db.from("payments").update({ status: "failed", failure_reason: error.slice(0, 300) }).eq("id", paymentId);
    return { ok: false, status, error: "We could not reach the payment provider. Your booking is saved; please try again shortly." };
  };

  if (provider === "stripe") {
    const { data: cust } = await db.from("customers").select("email").eq("id", b.customer_id).maybeSingle();
    const s = await createCheckoutSession({
      amountCents: plan.amountCents, currency, lines, successUrl: `${siteUrl}/pay/${token}?checkout=return`, cancelUrl: `${siteUrl}/pay/${token}?checkout=cancelled`,
      bookingId: b.id, paymentId, customerEmail: cust?.email ?? undefined, idempotencyKey: `pay-${paymentId}`,
    });
    if (!s.ok) return fail(s.error, 502);
    await db.from("payments").update({ provider_ref: s.id, stripe_session_id: s.id, checkout_url: s.url }).eq("id", paymentId);
    await db.from("bookings").update({ payment_status: "pending" }).eq("id", b.id);
    return { ok: true, provider: "stripe", url: s.url };
  }

  const o = await createOrder({ amountCents: plan.amountCents, currency, bookingId: b.id, paymentId, reference: b.reference, description: `Vanta Transportation booking ${b.reference}`, items: lines, requestId: `order-${paymentId}` });
  if (!o.ok) return fail(o.error, 502);
  await db.from("payments").update({ provider_ref: o.orderId }).eq("id", paymentId);
  await db.from("bookings").update({ payment_status: "pending" }).eq("id", b.id);
  return { ok: true, provider: "paypal", orderId: o.orderId };
}

/** Re-derives the booking's paid amount and payment status from its payment rows. */
async function syncBooking(db: SupabaseClient, bookingId: string) {
  const { data: rows } = await db.from("payments").select("amount_cents,refunded_cents,status,paid_at").eq("booking_id", bookingId);
  const paid = (rows ?? []).filter((r: Row) => r.paid_at);
  const net = paid.reduce((n: number, r: Row) => n + r.amount_cents - r.refunded_cents, 0);
  const refunded = paid.reduce((n: number, r: Row) => n + r.refunded_cents, 0);
  const { data: b } = await db.from("bookings").select("online_amount_cents").eq("id", bookingId).maybeSingle();
  const hasPending = (rows ?? []).some((r: Row) => r.status === "pending");
  let status = statusAfterPayment(b?.online_amount_cents ?? null, net) as string; // measured against the ONLINE amount, not the trip estimate
  if (refunded > 0) status = net <= 0 ? "refunded" : "partially_refunded";
  else if (net <= 0) status = hasPending ? "pending" : (rows ?? []).some((r: Row) => r.status === "failed") ? "failed" : "unpaid";
  await db.from("bookings").update({ amount_paid_cents: Math.max(0, net), payment_status: status }).eq("id", bookingId);
  return { net, status };
}

async function flagForReview(db: SupabaseClient, p: Row, reason: string, txnId: string | null) {
  await db.from("payments").update({ status: "review", failure_reason: reason, ...(txnId ? { provider_txn_id: txnId } : {}) }).eq("id", p.id);
  await db.from("bookings").update({ payment_status: "review" }).eq("id", p.booking_id);
  await db.from("admin_notifications").insert({ event: "payment.review", entity_type: "booking", entity_id: p.booking_id, title: "Payment needs review", body: "A payment did not match the expected amount. Open the booking.", link: `/admin/bookings/${p.booking_id}`, dedupe_key: `payment.review:${p.id}` });
}

/** Records a provider-CONFIRMED payment exactly once, then emails. Never confirms the booking itself. */
async function recordPaid(db: SupabaseClient, p: Row, txnId: string | null) {
  if (p.paid_at) return; // already recorded: retries and duplicate notifications change nothing
  await db.from("payments").update({
    status: "paid", paid_at: new Date().toISOString(), failure_reason: null,
    ...(txnId ? { provider_txn_id: txnId } : {}), ...(p.provider === "stripe" && txnId ? { stripe_payment_intent_id: txnId } : {}),
  }).eq("id", p.id);
  const { status } = await syncBooking(db, p.booking_id);
  const { data: b } = await db.from("bookings").select("reference,customer_id").eq("id", p.booking_id).maybeSingle();
  const { data: c } = b ? await db.from("customers").select("name,email").eq("id", b.customer_id).maybeSingle() : { data: null };
  await notify(db, "payment.paid", { type: "booking", id: p.booking_id }, {
    Reference: b?.reference ?? "", "Amount paid": formatMoney(p.amount_cents, p.currency), "Payment type": p.kind === "deposit" ? "Deposit" : "Online payment",
    "Payment status": status, "Payment provider": p.provider === "paypal" ? "PayPal" : "Card (Stripe)", Tier: p.tier_name ?? undefined,
    "Fixed tier price": p.fixed_price_cents != null ? formatMoney(p.fixed_price_cents, p.currency) : undefined,
    "Meet & Greet": p.meet_greet_cents > 0 ? formatMoney(p.meet_greet_cents, p.currency) : undefined,
    "Child car seats": p.other_addons_cents > 0 ? formatMoney(p.other_addons_cents, p.currency) : undefined,
    _customerEmail: c?.email ?? undefined, _customerName: c?.name ?? undefined,
  }, { dedupeSuffix: p.id });
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
  if (o.payment_intent) return (await db.from("payments").select("*").eq("stripe_payment_intent_id", o.payment_intent).maybeSingle()).data;
  return null;
}

async function applyStripe(db: SupabaseClient, ev: Evt) {
  const o = ev.data!.object;
  switch (ev.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const p = await findStripePayment(db, o);
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
