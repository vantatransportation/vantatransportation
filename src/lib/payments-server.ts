import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBookingSettings } from "@/lib/policies";
import { paymentPlan, statusAfterPayment } from "@/lib/payments";
import { createCheckoutSession, expireCheckoutSession, stripeConfigured } from "@/lib/stripe";
import { notify } from "@/lib/notify";
import { formatMoney } from "@/lib/pricing/engine";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validToken = (t: unknown): t is string => typeof t === "string" && UUID_RE.test(t);

export type CheckoutOutcome = { ok: true; url: string } | { ok: false; status: number; error: string };

/**
 * Creates a Stripe Checkout session for a booking. The amount comes ONLY from the booking's saved,
 * server-calculated total and the admin payment settings: nothing from the browser is used except the secret token.
 */
export async function startCheckout(db: SupabaseClient, token: string, siteUrl: string): Promise<CheckoutOutcome> {
  const { data: b } = await db.from("bookings").select("id,reference,status,estimated_fare_cents,currency,amount_paid_cents,customer_id").eq("payment_token", token).maybeSingle();
  if (!b) return { ok: false, status: 404, error: "We could not find that booking." };
  if (b.status === "cancelled" || b.status === "no_show") return { ok: false, status: 409, error: "This booking can no longer be paid online. Please contact us." };
  if (!stripeConfigured()) return { ok: false, status: 503, error: "Online payment is not available right now. We will confirm your booking and payment with you directly." };
  const settings = await loadBookingSettings(db);
  const plan = paymentPlan(settings.payment, b.estimated_fare_cents, b.amount_paid_cents ?? 0);
  if (!plan) return { ok: false, status: 409, error: "There is nothing to pay online for this booking right now." };

  // Retire any earlier unpaid session so the customer cannot pay twice.
  const { data: open } = await db.from("payments").select("id,stripe_session_id").eq("booking_id", b.id).eq("status", "pending");
  for (const p of open ?? []) {
    if (p.stripe_session_id) await expireCheckoutSession(p.stripe_session_id);
    await db.from("payments").update({ status: "expired" }).eq("id", p.id);
  }

  const ins = await db.from("payments").insert({ booking_id: b.id, amount_cents: plan.amountCents, currency: b.currency ?? "USD", kind: plan.kind, status: "pending" }).select("id").single();
  if (ins.error) return { ok: false, status: 500, error: "Could not start the payment. Please try again." };
  const { data: cust } = await db.from("customers").select("email").eq("id", b.customer_id).maybeSingle();

  const session = await createCheckoutSession({
    amountCents: plan.amountCents, currency: b.currency ?? "USD",
    productName: `Vanta Transportation ${b.reference} (${plan.kind === "deposit" ? "deposit" : "payment"})`,
    successUrl: `${siteUrl}/pay/${token}?checkout=return`, cancelUrl: `${siteUrl}/pay/${token}?checkout=cancelled`,
    bookingId: b.id, paymentId: ins.data.id, customerEmail: cust?.email ?? undefined, idempotencyKey: `pay-${ins.data.id}`,
  });
  if (!session.ok) {
    console.error("[payments] checkout failed", session.error);
    await db.from("payments").update({ status: "failed", failure_reason: session.error.slice(0, 300) }).eq("id", ins.data.id);
    return { ok: false, status: 502, error: "We could not reach the payment provider. Your booking is saved; please try again shortly." };
  }
  await db.from("payments").update({ stripe_session_id: session.id, checkout_url: session.url }).eq("id", ins.data.id);
  await db.from("bookings").update({ payment_status: "pending" }).eq("id", b.id);
  return { ok: true, url: session.url };
}

interface StripeEvent { id: string; type: string; data: { object: Record<string, any> } } // eslint-disable-line @typescript-eslint/no-explicit-any

/** Re-derives the booking's paid amount and payment status from its payment rows. */
async function syncBooking(db: SupabaseClient, bookingId: string) {
  const { data: rows } = await db.from("payments").select("amount_cents,refunded_cents,status,paid_at").eq("booking_id", bookingId);
  const paid = (rows ?? []).filter((r: { paid_at: string | null }) => r.paid_at);
  const net = paid.reduce((n: number, r: { amount_cents: number; refunded_cents: number }) => n + r.amount_cents - r.refunded_cents, 0);
  const refunded = paid.reduce((n: number, r: { refunded_cents: number }) => n + r.refunded_cents, 0);
  const { data: b } = await db.from("bookings").select("estimated_fare_cents").eq("id", bookingId).maybeSingle();
  const hasPending = (rows ?? []).some((r: { status: string }) => r.status === "pending");
  let status = statusAfterPayment(b?.estimated_fare_cents ?? null, net) as string;
  if (refunded > 0) status = net <= 0 ? "refunded" : "partially_refunded";
  else if (net <= 0) status = hasPending ? "pending" : (rows ?? []).some((r: { status: string }) => r.status === "failed") ? "failed" : "unpaid";
  await db.from("bookings").update({ amount_paid_cents: Math.max(0, net), payment_status: status }).eq("id", bookingId);
  return { net, status };
}

async function findPayment(db: SupabaseClient, o: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const bySession = o.object === "checkout.session" || String(o.id ?? "").startsWith("cs_");
  if (bySession) {
    const r = await db.from("payments").select("*").eq("stripe_session_id", o.id).maybeSingle();
    if (r.data) return r.data;
    if (o.metadata?.payment_id) return (await db.from("payments").select("*").eq("id", o.metadata.payment_id).maybeSingle()).data;
    return null;
  }
  if (o.payment_intent) return (await db.from("payments").select("*").eq("stripe_payment_intent_id", o.payment_intent).maybeSingle()).data;
  return null;
}

async function applyEvent(db: SupabaseClient, ev: StripeEvent) {
  const o = ev.data.object;
  switch (ev.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const p = await findPayment(db, o);
      if (!p) return;
      if (p.paid_at) return; // already recorded
      if (o.payment_status !== "paid") return; // e.g. delayed method still processing: stay pending
      const consistent = Number(o.amount_total) === p.amount_cents && String(o.currency ?? "").toLowerCase() === String(p.currency).toLowerCase() && o.metadata?.booking_id === p.booking_id;
      if (!consistent) {
        // Never mark as paid when the amount or booking does not match what we asked Stripe to charge.
        await db.from("payments").update({ status: "review", failure_reason: "Amount, currency or booking did not match.", stripe_payment_intent_id: o.payment_intent ?? null }).eq("id", p.id);
        await db.from("bookings").update({ payment_status: "review" }).eq("id", p.booking_id);
        await db.from("admin_notifications").insert({ event: "payment.review", entity_type: "booking", entity_id: p.booking_id, title: "Payment needs review", body: "A Stripe payment did not match the expected amount. Open the booking.", link: `/admin/bookings/${p.booking_id}`, dedupe_key: `payment.review:${p.id}` });
        return;
      }
      await db.from("payments").update({ status: "paid", paid_at: new Date().toISOString(), stripe_payment_intent_id: o.payment_intent ?? null, failure_reason: null }).eq("id", p.id);
      const { status } = await syncBooking(db, p.booking_id);
      const { data: b } = await db.from("bookings").select("reference,customer_id").eq("id", p.booking_id).maybeSingle();
      const { data: c } = b ? await db.from("customers").select("name,email").eq("id", b.customer_id).maybeSingle() : { data: null };
      // The booking status is NOT changed here: payment does not confirm a booking.
      await notify(db, "payment.paid", { type: "booking", id: p.booking_id }, {
        Reference: b?.reference ?? "", "Amount paid": formatMoney(p.amount_cents, p.currency), "Payment type": p.kind === "deposit" ? "Deposit" : "Full payment", "Payment status": status,
        _customerEmail: c?.email ?? undefined, _customerName: c?.name ?? undefined,
      }, { dedupeSuffix: p.id });
      return;
    }
    case "checkout.session.async_payment_failed": {
      const p = await findPayment(db, o);
      if (!p || p.paid_at) return;
      await db.from("payments").update({ status: "failed", failure_reason: "Payment failed" }).eq("id", p.id);
      await syncBooking(db, p.booking_id);
      return;
    }
    case "checkout.session.expired": {
      const p = await findPayment(db, o);
      if (!p || p.paid_at || p.status !== "pending") return;
      await db.from("payments").update({ status: "expired" }).eq("id", p.id);
      await syncBooking(db, p.booking_id);
      return;
    }
    case "charge.refunded": {
      const p = await findPayment(db, o);
      if (!p) return;
      const refunded = Math.min(Number(o.amount_refunded ?? 0), p.amount_cents);
      await db.from("payments").update({ refunded_cents: refunded, status: refunded >= p.amount_cents ? "refunded" : "partially_refunded" }).eq("id", p.id);
      await syncBooking(db, p.booking_id);
      return;
    }
  }
}

/**
 * Processes a VERIFIED Stripe event exactly once. The event id is recorded first; a repeat delivery is acknowledged
 * and ignored. If processing throws, the id is released so Stripe's retry can run it again.
 */
export async function processStripeEvent(db: SupabaseClient, ev: StripeEvent): Promise<"processed" | "duplicate"> {
  const ins = await db.from("stripe_events").insert({ id: ev.id, type: ev.type });
  if (ins.error) {
    if (ins.error.code === "23505") return "duplicate";
    throw new Error("could not record event");
  }
  try {
    await applyEvent(db, ev);
    return "processed";
  } catch (e) {
    await db.from("stripe_events").delete().eq("id", ev.id);
    throw e;
  }
}
