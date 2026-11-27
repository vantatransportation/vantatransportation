import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { statusAfterPayment } from "@/lib/payments";
import { CHARGE_REASON_TEXT, customerPricingOf, onlineCharge, type OnlineCharge } from "@/lib/tier-pricing";
import { driverEmailFields } from "@/lib/driver/email";
import { notify } from "@/lib/notify";
import { trackingUrl } from "@/lib/tracking-url";
import { formatMoney } from "@/lib/pricing/engine";
import { isConfirmableStatus, type BookingStatus } from "@/lib/booking-status";
import { getHelpline } from "@/lib/helpline";
import { BUSINESS_TZ } from "@/lib/config";
import { formatPickup } from "@/lib/geo/time";

/**
 * Shared payment building blocks used by every payment path (saved-card charge, PayPal, webhooks): the authoritative charge amount,
 * the booking-level payment status, review flags and, above all, recordPaid(): the ONE place a payment becomes "paid" and a booking "confirmed".
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validToken = (t: unknown): t is string => typeof t === "string" && UUID_RE.test(t);

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

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
const MONEY_STATES = ["pending", "authorized", "capture_pending", "capture_failed", "processing", "requires_action", "paid", "partially_refunded", "refunded", "review"];

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

export const BOOKING_COLUMNS = "id,reference,status,driver_id,approved_at,confirmed_at,customer_confirmed_at,payment_released_at,payment_status,currency,estimated_fare_cents,amount_paid_cents,customer_id,source_quote_request_id,tier_id,tier_name,fixed_price_cents,meet_greet_selected,meet_greet_fee_cents,child_seat_fee_cents,online_amount_cents,payment_token,card_flow,stripe_customer_id,stripe_payment_method_id,card_setup_at,card_brand,card_last4";


export const adminAlert = (db: SupabaseClient, bookingId: string, event: string, title: string, body: string) =>
  db.from("admin_notifications").insert({ event, entity_type: "booking", entity_id: bookingId, title, body, link: `/admin/bookings/${bookingId}` });

/**
 * Re-derives the booking's paid amount and payment status from its payment rows (and whether a card is saved).
 * Order of precedence when nothing has been paid: a held legacy authorization, a charge needing customer action, a charge in progress, a pending attempt,
 * a payment that needs follow-up, a failed attempt, a saved card (nothing charged), otherwise unpaid. Money only ever shows as paid when a row has paid_at,
 * which only recordPaid() sets from a provider-verified result.
 */
export async function syncBooking(db: SupabaseClient, bookingId: string) {
  const { data: rows } = await db.from("payments").select("amount_cents,refunded_cents,status,paid_at").eq("booking_id", bookingId);
  const paid = (rows ?? []).filter((r: Row) => r.paid_at);
  const net = paid.reduce((n: number, r: Row) => n + r.amount_cents - r.refunded_cents, 0);
  const refunded = paid.reduce((n: number, r: Row) => n + r.refunded_cents, 0);
  const { data: b } = await db.from("bookings").select("online_amount_cents,card_setup_at").eq("id", bookingId).maybeSingle();
  const has = (...s: string[]) => (rows ?? []).some((r: Row) => s.includes(r.status));
  let status = statusAfterPayment(b?.online_amount_cents ?? null, net) as string; // measured against the ONLINE amount, not the trip estimate
  if (refunded > 0) status = net <= 0 ? "refunded" : "partially_refunded";
  else if (net <= 0) status = has("authorized") ? "authorized" : has("requires_action") ? "requires_action" : has("processing") ? "processing" : has("pending", "capture_pending") ? "pending" : has("authorization_expired", "capture_failed") ? "needs_payment" : has("failed") ? "failed" : b?.card_setup_at ? "card_saved" : "unpaid";
  await db.from("bookings").update({ amount_paid_cents: Math.max(0, net), payment_status: status }).eq("id", bookingId);
  return { net, status };
}

export async function flagForReview(db: SupabaseClient, p: Row, reason: string, txnId: string | null) {
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
export async function recordPaid(db: SupabaseClient, p: Row, txnId: string | null) {
  if (p.paid_at) return; // already recorded: retries and duplicate notifications change nothing
  const claim = await db.from("payments").update({
    status: "paid", paid_at: new Date().toISOString(), failure_reason: null,
    ...(txnId ? { provider_txn_id: txnId } : {}), ...(p.provider === "stripe" && txnId ? { stripe_payment_intent_id: txnId } : {}),
  }).eq("id", p.id).is("paid_at", null).select("id");
  if (claim.error) throw new Error("could not record payment"); // the provider retries the event
  if (!claim.data?.length) return; // another delivery recorded it first
  const { status } = await syncBooking(db, p.booking_id);

  const { data: b } = await db.from("bookings").select("id,reference,status,customer_id,driver_id,approved_at,customer_confirmed_at,payment_released_at,confirmed_at,tracking_code,pickup_at,pickup_address,dropoff_address,online_amount_cents,amount_paid_cents,currency,tier_name,vehicles(name)").eq("id", p.booking_id).maybeSingle();
  const { data: c } = b ? await db.from("customers").select("name,email").eq("id", b.customer_id).maybeSingle() : { data: null };
  const covered = status === "paid" || status === "deposit_paid"; // the verified amount satisfies what the booking asked for online
  // A booking becomes CONFIRMED only when ALL of these hold: an admin approved it (approved_at, set by the admin route only), the customer explicitly
  // confirmed (customer_confirmed_at, set by the customer's own confirm action) and Stripe/PayPal VERIFIED the payment. A payment made through a
  // pre-existing, customer-initiated route (an old payment link, a PayPal approval) is itself the customer's explicit act, so those rows do not need the stamp.
  const explicit = Boolean(b?.customer_confirmed_at) || p.saved_card !== true;
  const confirmable = Boolean(b && covered && b.approved_at && explicit && isConfirmableStatus(b.status as BookingStatus));
  let confirmedNow = false;
  if (b && confirmable && !b.confirmed_at) {
    const now = new Date().toISOString();
    const won = await db.from("bookings").update({ confirmed_at: now }).eq("id", b.id).is("confirmed_at", null).select("id");
    if (won.error) throw new Error("could not confirm booking");
    if (won.data?.length) {
      confirmedNow = true;
      // 'approved' (or a legacy approved+assigned row) becomes 'confirmed'. Driver assignment is a separate, later admin action.
      const moved = await db.from("bookings").update({ status: "confirmed" }).eq("id", b.id).in("status", ["approved", "assigned"]).select("id");
      await db.from("booking_status_history").insert({ booking_id: b.id, from_status: b.status, to_status: moved.data?.length ? "confirmed" : b.status, actor_type: "system", actor_id: null, note: `Confirmed after verified ${p.provider === "paypal" ? "PayPal" : "card"} payment` });
    }
  }

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
      _trackingId: b.tracking_code ?? undefined, _trackUrl: trackingUrl(b.tracking_code) ?? undefined,
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
