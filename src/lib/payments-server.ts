import { driverEmailFields } from "@/lib/driver/email";
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBookingSettings } from "@/lib/policies";
import { decimalToCents, paymentPlan, statusAfterPayment } from "@/lib/payments";
import { cancelPaymentIntent, capturePaymentIntent, createCheckoutSession, expireCheckoutSession, retrievePaymentIntent, type StripePI } from "@/lib/stripe";
import { captureOrder, createOrder } from "@/lib/paypal";
import { verifyPayPalOrder } from "@/lib/paypal-verify";
import { availableProviders, type Provider } from "@/lib/payment-providers";
import { CHARGE_REASON_TEXT, customerPricingOf, onlineCharge, type OnlineCharge } from "@/lib/tier-pricing";
import { notify } from "@/lib/notify";
import { formatMoney } from "@/lib/pricing/engine";
import { isOpenForDriver, type BookingStatus } from "@/lib/booking-status";
import { getHelpline } from "@/lib/helpline";
import { BUSINESS_TZ } from "@/lib/config";
import { formatPickup } from "@/lib/geo/time";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validToken = (t: unknown): t is string => typeof t === "string" && UUID_RE.test(t);
export type { Provider };

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type CheckoutOutcome =
  | { ok: true; provider: "stripe"; url: string }
  | { ok: true; provider: "paypal"; orderId: string }
  | { ok: false; status: number; error: string };

/**
 * The ONLINE charge for a booking, always from trusted data and never from the browser. It is the COMPLETE booking total:
 *   tier fixed fee + server-calculated trip estimate + Meet & Greet (if selected) + child seats.
 * The amount is frozen on the booking when it is requested (online_amount_cents, with fixed_price_cents, the add-on fees and
 * estimated_fare_cents recording its parts), so later admin changes to tier prices or rates never rewrite it.
 *
 * Bookings created BEFORE this fix froze only fixed + Meet & Greet + seats (they under-charged: the trip fare was left out).
 * Such a booking is re-frozen ONCE at the complete total, but only while no money has been held, started or taken for it and it is
 * still open. If a hold or payment already exists the frozen amount is honoured unchanged (history is never rewritten).
 */
const TERMINAL = ["cancelled", "no_show", "rejected", "completed"];
const MONEY_STATES = ["pending", "authorized", "capture_pending", "capture_failed", "paid", "partially_refunded", "refunded", "review"];

export async function chargeForBooking(db: SupabaseClient, b: Row): Promise<{ ok: true; charge: OnlineCharge } | { ok: false; error: string }> {
  if (b.online_amount_cents != null && b.fixed_price_cents != null) {
    const mg = b.meet_greet_selected ? b.meet_greet_fee_cents : 0;
    if (b.meet_greet_selected && (mg == null || mg <= 0)) return { ok: false, error: "The Meet & Greet fee for this booking is missing. Please contact us." };
    const addons = b.child_seat_fee_cents ?? 0;
    const tripEstimate = b.online_amount_cents - b.fixed_price_cents - (mg ?? 0) - addons; // what the frozen total holds beyond the tier fee and services
    if (tripEstimate < 0) return { ok: false, error: "The saved amount for this booking is inconsistent. Please contact us." };
    // Pre-fix booking (trip fare missing from the frozen amount): upgrade it once, only while nothing has been held or paid.
    if (tripEstimate === 0 && (b.estimated_fare_cents ?? 0) > 0 && !b.source_quote_request_id && !TERMINAL.includes(String(b.status))) {
      const { data: money } = await db.from("payments").select("id,status,paid_at").eq("booking_id", b.id);
      const touched = (money ?? []).some((r: Row) => r.paid_at || MONEY_STATES.includes(String(r.status))) || (b.amount_paid_cents ?? 0) > 0;
      if (!touched) {
        const total = b.fixed_price_cents + b.estimated_fare_cents + (mg ?? 0) + addons;
        const up = await db.from("bookings").update({ online_amount_cents: total }).eq("id", b.id).eq("online_amount_cents", b.online_amount_cents).select("id");
        if (!up.error && up.data?.length) {
          await db.from("activity_logs").insert({ action: "booking.charge_upgraded", entity_type: "booking", entity_id: b.id, meta: { previousCents: b.online_amount_cents, newCents: total, reason: "trip fare added to the online amount" } });
          return { ok: true, charge: { tierId: b.tier_id ?? null, tierName: b.tier_name ?? "", fixedPriceCents: b.fixed_price_cents, tripEstimateCents: b.estimated_fare_cents, meetGreetCents: mg ?? 0, addonsCents: addons, totalCents: total } };
        }
        // lost a race (another request upgraded or paid it first): re-read below on the next call; use the stored value now
        const again = await db.from("bookings").select("online_amount_cents").eq("id", b.id).maybeSingle();
        const amt = again.data?.online_amount_cents ?? b.online_amount_cents;
        return { ok: true, charge: { tierId: b.tier_id ?? null, tierName: b.tier_name ?? "", fixedPriceCents: b.fixed_price_cents, tripEstimateCents: amt - b.fixed_price_cents - (mg ?? 0) - addons, meetGreetCents: mg ?? 0, addonsCents: addons, totalCents: amt } };
      }
    }
    return { ok: true, charge: { tierId: b.tier_id ?? null, tierName: b.tier_name ?? "", fixedPriceCents: b.fixed_price_cents, tripEstimateCents: tripEstimate, meetGreetCents: mg ?? 0, addonsCents: addons, totalCents: b.online_amount_cents } };
  }
  // Quote conversions carry an agreed price that is arranged with the customer directly: no automatic tier-based online charge.
  if (b.source_quote_request_id) return { ok: false, error: "Online payment is not available for this booking. We will arrange payment with you directly." };
  if (!b.tier_id) return { ok: false, error: "Online payment is not available for this booking. We will arrange payment with you directly." };
  const { data: t } = await db.from("vehicle_tiers").select("id,name,fixed_price_cents,meet_greet_fee_cents").eq("id", b.tier_id).maybeSingle();
  const r = onlineCharge(t ? { id: t.id, name: t.name, fixedPriceCents: t.fixed_price_cents ?? null, meetGreetFeeCents: t.meet_greet_fee_cents ?? null } : null, { meetGreet: Boolean(b.meet_greet_selected), addonsCents: b.child_seat_fee_cents ?? 0, tripEstimateCents: b.estimated_fare_cents ?? null });
  if (!r.ok) return { ok: false, error: r.reason === "price_not_set" || r.reason === "trip_fare_unavailable" ? "Online payment is not available for this booking yet." : CHARGE_REASON_TEXT[r.reason] };
  await db.from("bookings").update({ tier_name: r.charge.tierName, fixed_price_cents: r.charge.fixedPriceCents, meet_greet_fee_cents: b.meet_greet_selected ? r.charge.meetGreetCents : null, online_amount_cents: r.charge.totalCents }).eq("id", b.id);
  return r;
}

/**
 * The lines a payment provider shows the customer. They add up to `amountCents`, and contain only the combined Trip fare
 * and the separately displayed services: never the tier fee, a rate or any internal component. A deposit is a single line.
 */
export function customerLines(charge: OnlineCharge, reference: string, amountCents: number): { name: string; amountCents: number }[] {
  if (amountCents !== charge.totalCents) return [{ name: `Deposit for booking ${reference}`, amountCents }];
  const p = customerPricingOf(charge);
  return [
    { name: `Trip fare (${reference})`, amountCents: p.tripFareCents },
    ...(p.meetGreetCents > 0 ? [{ name: "Airport Meet & Greet", amountCents: p.meetGreetCents }] : []),
    ...(p.childSeatCents > 0 ? [{ name: "Child car seats", amountCents: p.childSeatCents }] : []),
  ];
}

const BOOKING_COLUMNS = "id,reference,status,driver_id,payment_released_at,currency,estimated_fare_cents,amount_paid_cents,customer_id,source_quote_request_id,tier_id,tier_name,fixed_price_cents,meet_greet_selected,meet_greet_fee_cents,child_seat_fee_cents,online_amount_cents";

/**
 * Starts a payment with the chosen provider. The amount is recalculated here from the database; the only things the
 * browser supplies are the private booking token and which provider it wants.
 */
export async function startCheckout(db: SupabaseClient, token: string, provider: Provider, siteUrl: string): Promise<CheckoutOutcome> {
  const { data: b } = await db.from("bookings").select(BOOKING_COLUMNS).eq("payment_token", token).maybeSingle();
  if (!b) return { ok: false, status: 404, error: "We could not find that booking." };
  if (b.status === "cancelled" || b.status === "no_show" || b.status === "rejected" || b.status === "completed") return { ok: false, status: 409, error: "This booking can no longer be paid online. Please contact us." };
  // Payment is released only AFTER an admin approves the booking and assigns a driver. A payment link or token alone is not enough.
  if (!b.payment_released_at || !b.driver_id || !isOpenForDriver(b.status as BookingStatus)) return { ok: false, status: 409, error: "This booking has not been approved yet. We will email you a secure payment link as soon as it is approved. You have not been charged." };
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

  // A customer paying again (for example after a failed capture or an expired hold) replaces any old hold: release it so they are never charged twice.
  const { data: held } = await db.from("payments").select("id,status,stripe_payment_intent_id").eq("booking_id", b.id).eq("manual_capture", true).in("status", ["authorized", "capture_failed", "capture_pending"]);
  if ((held ?? []).some((h: Row) => h.status === "capture_pending")) return { ok: false, status: 409, error: "Your payment is being processed. Please wait a moment and refresh this page." };
  for (const h of held ?? []) { if (h.stripe_payment_intent_id) await cancelPaymentIntent(h.stripe_payment_intent_id); await db.from("payments").update({ status: "canceled" }).eq("id", h.id); }

  const currency = b.currency ?? "USD";
  const ins = await db.from("payments").insert({
    booking_id: b.id, provider, amount_cents: plan.amountCents, currency, kind: plan.kind, status: "pending",
    tier_id: charge.tierId, tier_name: charge.tierName, fixed_price_cents: charge.fixedPriceCents, meet_greet_cents: charge.meetGreetCents,
    other_addons_cents: charge.addonsCents, estimated_trip_fare_cents: charge.tripEstimateCents,
  }).select("id").single();
  if (ins.error) return { ok: false, status: 500, error: "Could not start the payment. Please try again." };
  const paymentId: string = ins.data.id;

  // Line items shown to the customer by the provider. A deposit is a single line.
  const lines = customerLines(charge, String(b.reference), plan.amountCents);
  const fail = async (error: string, status: number): Promise<CheckoutOutcome> => {
    console.error(`[payments] ${provider} checkout failed`, error);
    await db.from("payments").update({ status: "failed", failure_reason: error.slice(0, 300) }).eq("id", paymentId);
    return { ok: false, status, error: "We could not reach the payment provider. Your booking is saved; please try again shortly." };
  };

  if (provider === "stripe") {
    const { data: cust } = await db.from("customers").select("email").eq("id", b.customer_id).maybeSingle();
    const s = await createCheckoutSession({
      amountCents: plan.amountCents, currency, lines, successUrl: `${siteUrl}/pay/${token}?checkout=return`, cancelUrl: `${siteUrl}/pay/${token}?checkout=cancelled`,
      bookingId: b.id, paymentId, customerEmail: cust?.email ?? undefined, idempotencyKey: `pay-${paymentId}`, description: `Vanta Transportation booking ${b.reference}`,
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
  const hasPending = (rows ?? []).some((r: Row) => r.status === "pending" || r.status === "capture_pending");
  const hasAuthorized = (rows ?? []).some((r: Row) => r.status === "authorized");
  const needsPayment = (rows ?? []).some((r: Row) => r.status === "authorization_expired" || r.status === "capture_failed");
  let status = statusAfterPayment(b?.online_amount_cents ?? null, net) as string; // measured against the ONLINE amount, not the trip estimate
  if (refunded > 0) status = net <= 0 ? "refunded" : "partially_refunded";
  else if (net <= 0) status = hasAuthorized ? "authorized" : hasPending ? "pending" : needsPayment ? "needs_payment" : (rows ?? []).some((r: Row) => r.status === "failed") ? "failed" : "unpaid";
  await db.from("bookings").update({ amount_paid_cents: Math.max(0, net), payment_status: status }).eq("id", bookingId);
  return { net, status };
}

async function flagForReview(db: SupabaseClient, p: Row, reason: string, txnId: string | null) {
  await db.from("payments").update({ status: "review", failure_reason: reason, ...(txnId ? { provider_txn_id: txnId } : {}) }).eq("id", p.id);
  await db.from("bookings").update({ payment_status: "review" }).eq("id", p.booking_id);
  await db.from("admin_notifications").insert({ event: "payment.review", entity_type: "booking", entity_id: p.booking_id, title: "Payment needs review", body: "A payment did not match the expected amount. Open the booking.", link: `/admin/bookings/${p.booking_id}`, dedupe_key: `payment.review:${p.id}` });
}

/**
 * Records a provider-VERIFIED payment exactly once, then confirms the booking and emails.
 *
 * Callers reach this only after a webhook signature (Stripe), PayPal's verification API, or a server-side PayPal capture check has
 * proven the payment. An admin click, a success page or a browser callback never gets here.
 *  - The payment row is claimed with a conditional update (paid_at IS NULL), so two deliveries racing each other cannot both record it.
 *  - The booking is confirmed with its own conditional update (confirmed_at IS NULL), so only one delivery sends the confirmation email,
 *    and the notification dedupe keys stop a retried webhook from emailing again.
 *  - A payment that arrives for a booking that is no longer open (cancelled, declined, ...) is recorded, NOT confirmed, and flagged to admin.
 *    Nothing is refunded automatically.
 */
async function recordPaid(db: SupabaseClient, p: Row, txnId: string | null) {
  if (p.paid_at) return; // already recorded: retries and duplicate notifications change nothing
  const claim = await db.from("payments").update({
    status: "paid", paid_at: new Date().toISOString(), failure_reason: null,
    ...(txnId ? { provider_txn_id: txnId } : {}), ...(p.provider === "stripe" && txnId ? { stripe_payment_intent_id: txnId } : {}),
  }).eq("id", p.id).is("paid_at", null).select("id");
  if (claim.error) throw new Error("could not record payment"); // the provider retries the event
  if (!claim.data?.length) return; // another delivery recorded it first
  const { status } = await syncBooking(db, p.booking_id);

  const { data: b } = await db.from("bookings").select("id,reference,status,customer_id,driver_id,payment_released_at,confirmed_at,tracking_code,pickup_at,pickup_address,dropoff_address,online_amount_cents,amount_paid_cents,currency,tier_name,vehicles(name)").eq("id", p.booking_id).maybeSingle();
  const { data: c } = b ? await db.from("customers").select("name,email").eq("id", b.customer_id).maybeSingle() : { data: null };
  const covered = status === "paid" || status === "deposit_paid"; // the verified amount satisfies what the booking asked for online
  const confirmable = Boolean(b && covered && b.driver_id && b.payment_released_at && isOpenForDriver(b.status as BookingStatus));
  let confirmedNow = false;
  if (b && confirmable && !b.confirmed_at) {
    const now = new Date().toISOString();
    const won = await db.from("bookings").update({ confirmed_at: now }).eq("id", b.id).is("confirmed_at", null).select("id");
    if (won.error) throw new Error("could not confirm booking");
    if (won.data?.length) {
      confirmedNow = true;
      // 'assigned' becomes 'confirmed'; a ride the driver has already started keeps its (later) status.
      const moved = await db.from("bookings").update({ status: "confirmed" }).eq("id", b.id).eq("status", "assigned").select("id");
      await db.from("booking_status_history").insert({ booking_id: b.id, from_status: moved.data?.length ? "assigned" : b.status, to_status: moved.data?.length ? "confirmed" : b.status, actor_type: "system", actor_id: null, note: `Confirmed after verified ${p.provider === "paypal" ? "PayPal" : "card"} payment` });
    }
  }

  const site = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/$/, "");
  if (b && confirmedNow && c?.email) {
    const [stops, helpline] = await Promise.all([db.from("booking_stops").select("position,address").eq("booking_id", b.id).order("position"), getHelpline(db)]);
    const veh = b.vehicles as { name?: string } | null;
    const remaining = b.online_amount_cents != null ? Math.max(0, b.online_amount_cents - (b.amount_paid_cents ?? 0)) : 0; // amount_paid_cents was just re-derived from the verified payments
    await notify(db, "booking.confirmed", { type: "booking", id: b.id }, {
      ...(await driverEmailFields(db, b.driver_id)),
      Reference: b.reference, Pickup: String(b.pickup_address ?? ""), Stops: (stops.data ?? []).map((s: Row) => String(s.address)).join(" | ") || undefined, Destination: b.dropoff_address ?? undefined,
      When: b.pickup_at ? formatPickup(b.pickup_at, BUSINESS_TZ) : undefined, Vehicle: [veh?.name, b.tier_name].filter(Boolean).join(" · ") || undefined,
      "Amount paid": formatMoney(p.amount_cents, p.currency), "Payment status": status === "paid" ? "Paid in full" : "Deposit received",
      "Remaining online balance": status === "deposit_paid" && remaining > 0 ? formatMoney(remaining, p.currency) : undefined,
      "Vanta support phone": helpline?.display,
      _trackingId: b.tracking_code ?? undefined, _trackUrl: site && b.tracking_code ? `${site}/track#id=${b.tracking_code}` : undefined,
      _customerEmail: c.email, _customerName: c.name ?? undefined,
    }, { dedupeSuffix: "confirmed" });
  }
  // Business alert + email: once per payment row (the key includes the payment id).
  await notify(db, "payment.paid", { type: "booking", id: p.booking_id }, {
    Reference: b?.reference ?? "", "Amount paid": formatMoney(p.amount_cents, p.currency), "Payment type": p.kind === "deposit" ? "Deposit" : "Online payment",
    "Payment status": status, "Payment provider": p.provider === "paypal" ? "PayPal" : "Card (Stripe)", Tier: p.tier_name ?? undefined,
    "Fixed tier price": p.fixed_price_cents != null ? formatMoney(p.fixed_price_cents, p.currency) : undefined,
    "Trip estimate (internal)": p.estimated_trip_fare_cents != null ? formatMoney(p.estimated_trip_fare_cents, p.currency) : undefined,
    "Meet & Greet": p.meet_greet_cents > 0 ? formatMoney(p.meet_greet_cents, p.currency) : undefined,
    "Child car seats": p.other_addons_cents > 0 ? formatMoney(p.other_addons_cents, p.currency) : undefined,
    Confirmed: confirmable || b?.confirmed_at ? "Yes" : "No",
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

// ================================================================ Stripe: authorize now, capture on admin approval
// The customer authorizes the card on Stripe's hosted page at booking time (a HOLD, no charge). An administrator's approval captures it,
// server-side. A payment becomes "paid" ONLY through recordPaid(), reached only from a Stripe-verified capture: Stripe's own API reply to
// our capture call, or a signature-verified payment_intent.succeeded webhook. Never from a browser, a redirect or an admin click alone.
// An expired or failed authorization NEVER cancels, confirms or declines the booking: it becomes "needs_payment" and an admin follows up.

const adminAlert = (db: SupabaseClient, bookingId: string, event: string, title: string, body: string) =>
  db.from("admin_notifications").insert({ event, entity_type: "booking", entity_id: bookingId, title, body });

const capBefore = (pi: StripePI): { brand: string | null; last4: string | null; captureBefore: string | null } => {
  const c = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge.payment_method_details?.card : undefined;
  return { brand: c?.brand ?? null, last4: c?.last4 ?? null, captureBefore: c?.capture_before ? new Date(Number(c.capture_before) * 1000).toISOString() : null };
};

/** Creates the hosted authorization page for a freshly saved booking. Failure is harmless: the booking continues with the normal pay-after-approval link. */
export async function startAuthorization(db: SupabaseClient, bookingId: string, siteUrl: string): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const { data: b } = await db.from("bookings").select(BOOKING_COLUMNS).eq("id", bookingId).maybeSingle();
  if (!b) return { ok: false, reason: "not_found" };
  if (!["new_request", "pending_confirmation"].includes(String(b.status))) return { ok: false, reason: "not_awaiting_review" };
  const settings = await loadBookingSettings(db);
  if (!settings.authorizeAtBooking) return { ok: false, reason: "disabled" };
  if (!availableProviders(settings).includes("stripe")) return { ok: false, reason: "stripe_unavailable" };
  const c = await chargeForBooking(db, b);
  if (!c.ok) return { ok: false, reason: "no_online_charge" };
  const plan = paymentPlan(settings.payment, c.charge.totalCents, b.amount_paid_cents ?? 0);
  if (!plan) return { ok: false, reason: "nothing_due" };
  // Never create a second authorization for a booking that already holds one (or is waiting for / capturing one): retries are harmless.
  const { data: live } = await db.from("payments").select("id").eq("booking_id", b.id).eq("provider", "stripe").eq("manual_capture", true).in("status", ["authorized", "capture_pending"]);
  if (live?.length) return { ok: false, reason: "already_authorized" };
  const { data: open } = await db.from("payments").select("id,provider_ref").eq("booking_id", b.id).eq("provider", "stripe").eq("status", "pending");
  for (const p of open ?? []) { if (p.provider_ref) await expireCheckoutSession(p.provider_ref); await db.from("payments").update({ status: "expired" }).eq("id", p.id); }
  const currency = b.currency ?? "USD";
  const ins = await db.from("payments").insert({
    booking_id: b.id, provider: "stripe", amount_cents: plan.amountCents, currency, kind: plan.kind, status: "pending", manual_capture: true,
    tier_id: c.charge.tierId, tier_name: c.charge.tierName, fixed_price_cents: c.charge.fixedPriceCents, meet_greet_cents: c.charge.meetGreetCents,
    other_addons_cents: c.charge.addonsCents, estimated_trip_fare_cents: c.charge.tripEstimateCents,
  }).select("id").single();
  if (ins.error) return { ok: false, reason: "db" };
  const paymentId: string = ins.data.id;
  const lines = customerLines(c.charge, String(b.reference), plan.amountCents);
  const { data: cust } = await db.from("customers").select("email").eq("id", b.customer_id).maybeSingle();
  const ref = encodeURIComponent(String(b.reference));
  const s = await createCheckoutSession({ amountCents: plan.amountCents, currency, lines, successUrl: `${siteUrl}/book/confirmation?ref=${ref}&card=authorized`, cancelUrl: `${siteUrl}/book/confirmation?ref=${ref}&card=cancelled`, bookingId: b.id, paymentId, customerEmail: cust?.email ?? undefined, idempotencyKey: `auth-${paymentId}`, manualCapture: true, description: `Vanta Transportation booking ${b.reference}` });
  if (!s.ok) { console.error("[payments] authorization session failed", s.error); await db.from("payments").update({ status: "failed", failure_reason: s.error.slice(0, 300) }).eq("id", paymentId); return { ok: false, reason: "stripe_error" }; }
  await db.from("payments").update({ provider_ref: s.id, stripe_session_id: s.id, checkout_url: s.url }).eq("id", paymentId);
  return { ok: true, url: s.url };
}

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

export type CaptureResult =
  | { ok: true; status: "paid" }
  | { ok: false; code: "no_authorization" | "in_progress" | "mismatch" | "not_ready" | "expired" | "failed"; error: string };

/**
 * Admin approval's capture step. Validates everything against authoritative records before any money moves:
 *  - the payment is this booking's, Stripe's own record agrees (booking, currency, state, held amount);
 *  - the amount equals what the existing pricing/payment plan says is due (never a number supplied by a browser);
 *  - a conditional status change claims the capture, so a double click or a retry cannot capture twice.
 * Only Stripe's confirmation that the capture SUCCEEDED leads to recordPaid().
 */
export async function captureAuthorization(db: SupabaseClient, bookingId: string): Promise<CaptureResult> {
  const { data: p } = await db.from("payments").select("*").eq("booking_id", bookingId).eq("provider", "stripe").eq("manual_capture", true).in("status", ["authorized", "capture_failed", "capture_pending"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!p) return { ok: false, code: "no_authorization", error: "There is no card authorization to capture for this booking." };
  if (p.status === "capture_pending") return { ok: false, code: "in_progress", error: "A capture is already in progress for this booking." };
  if (!p.stripe_payment_intent_id) return { ok: false, code: "not_ready", error: "Stripe has not confirmed the card hold yet. Try again in a moment." };
  const { data: b } = await db.from("bookings").select(BOOKING_COLUMNS).eq("id", bookingId).maybeSingle();
  if (!b) return { ok: false, code: "mismatch", error: "Booking not found." };
  const settings = await loadBookingSettings(db);
  const c = await chargeForBooking(db, b);
  const plan = c.ok ? paymentPlan(settings.payment, c.charge.totalCents, b.amount_paid_cents ?? 0) : null;
  if (!plan || plan.amountCents !== p.amount_cents) {
    await db.from("payments").update({ last_error: "The authorized amount no longer matches the amount due." }).eq("id", p.id);
    return { ok: false, code: "mismatch", error: "The authorized amount no longer matches the amount due for this booking. Nothing was charged." };
  }
  const attempt = (p.capture_attempts ?? 0) + 1;
  const claim = await db.from("payments").update({ status: "capture_pending", capture_attempts: attempt }).eq("id", p.id).eq("status", p.status).select("id");
  if (claim.error || !claim.data?.length) return { ok: false, code: "in_progress", error: "A capture is already in progress for this booking." };
  const restore = (status: string, error: string) => db.from("payments").update({ status, last_error: error.slice(0, 300), failure_reason: error.slice(0, 300) }).eq("id", p.id);
  const needs = async (status: "capture_failed" | "authorization_expired", error: string) => {
    await restore(status, error); await syncBooking(db, bookingId);
    await adminAlert(db, bookingId, "payment.needs_payment", "Needs payment: capture did not complete", error);
  };
  try {
    const live = await retrievePaymentIntent(p.stripe_payment_intent_id);
    if (!live.ok) { await restore(p.status, live.error); await syncBooking(db, bookingId); return { ok: false, code: "failed", error: "Could not reach Stripe to check the payment. Nothing was charged. Try again." }; }
    const pi = live.pi;
    if (pi.metadata?.booking_id !== bookingId || String(pi.currency).toLowerCase() !== String(p.currency).toLowerCase()) { await restore(p.status, "Stripe's record does not match this booking."); await flagForReview(db, p, "Stripe's payment record does not match this booking.", pi.id); return { ok: false, code: "mismatch", error: "Stripe's record does not match this booking. Nothing was charged." }; }
    if (pi.status === "succeeded") { // already captured (for example the webhook was delayed): Stripe's own record is the proof
      if (Number(pi.amount_received) !== p.amount_cents) { await flagForReview(db, p, "Captured amount did not match.", pi.id); return { ok: false, code: "mismatch", error: "The captured amount does not match. Flagged for review." }; }
      await db.from("payments").update({ captured_amount_cents: pi.amount_received }).eq("id", p.id);
      await recordPaid(db, { ...p, status: "capture_pending" }, pi.id);
      return { ok: true, status: "paid" };
    }
    if (pi.status === "canceled") { await needs("authorization_expired", "The card authorization expired or was released before capture."); return { ok: false, code: "expired", error: "The card authorization has expired. The booking stays active and unpaid; ask the customer to pay again (the payment link was emailed)." }; }
    if (pi.status !== "requires_capture" || Number(pi.amount_capturable) !== p.amount_cents) { await restore(p.status, `Unexpected Stripe state: ${pi.status}`); await syncBooking(db, bookingId); return { ok: false, code: "not_ready", error: `Stripe reports the payment as "${pi.status}", so it cannot be captured now.` }; }
    const cap = await capturePaymentIntent(pi.id, p.amount_cents, `capture-${p.id}-${attempt}`);
    if (!cap.ok) {
      const gone = cap.code === "payment_intent_unexpected_state" || /expired|canceled|cancelled/i.test(cap.error);
      await needs(gone ? "authorization_expired" : "capture_failed", `Capture failed: ${cap.error}`);
      return { ok: false, code: gone ? "expired" : "failed", error: gone ? "The card authorization has expired. The booking stays active and unpaid." : `Stripe could not capture the payment: ${cap.error}` };
    }
    if (cap.pi.status !== "succeeded" || Number(cap.pi.amount_received) !== p.amount_cents) { await needs("capture_failed", `Capture did not complete (Stripe status: ${cap.pi.status}).`); return { ok: false, code: "failed", error: "Stripe did not confirm the capture. Nothing is marked paid." }; }
    await db.from("payments").update({ captured_amount_cents: cap.pi.amount_received }).eq("id", p.id);
    await recordPaid(db, { ...p, status: "capture_pending" }, cap.pi.id);
    return { ok: true, status: "paid" };
  } catch (e) {
    await needs("capture_failed", `Capture error: ${e instanceof Error ? e.message : "unknown"}`);
    return { ok: false, code: "failed", error: "The capture could not be completed. Nothing is marked paid." };
  }
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
