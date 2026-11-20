import type { Metadata } from "next";
import Link from "next/link";
import PaymentChoice from "@/components/PaymentChoice";
import { getAdminClient } from "@/lib/supabase/admin";
import { loadBookingSettings } from "@/lib/policies";
import { paymentPlan } from "@/lib/payments";
import { availableProviders } from "@/lib/payment-providers";
import { chargeForBooking } from "@/lib/payments-server";
import { paypalClientId } from "@/lib/paypal";
import { validToken } from "@/lib/payments-server";
import { formatMoney } from "@/lib/pricing/engine";
import { formatPickup } from "@/lib/geo/time";
import { BUSINESS_TZ } from "@/lib/config";

export const metadata: Metadata = { title: "Pay for your booking", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const STATUS_TEXT: Record<string, string> = {
  not_required: "No online payment is requested for this booking.", unpaid: "Not paid yet.", pending: "Payment started. Waiting for confirmation from our payment provider.",
  deposit_paid: "Deposit received.", paid: "Paid in full.", failed: "The last payment attempt did not go through.", refunded: "Refunded.",
  partially_refunded: "Partially refunded.", review: "Our team is reviewing a payment on this booking. We will contact you.",
};

export default async function PayPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await params;
  const sp = await searchParams;
  const back = Array.isArray(sp.checkout) ? sp.checkout[0] : sp.checkout;
  const db = validToken(token) ? getAdminClient() : null;
  const { data: b } = db ? await db.from("bookings").select("id,reference,status,pickup_at,estimated_fare_cents,currency,amount_paid_cents,payment_status,child_seat_fee_cents,driver_id,payment_released_at,rush_surcharge_cents,tip_cents,tier_id,tier_name,fixed_price_cents,meet_greet_selected,meet_greet_fee_cents,online_amount_cents").eq("payment_token", token).maybeSingle() : { data: null };

  if (!db || !b) {
    return (
      <section className="page-head"><div className="container"><h1>Payment link not found</h1><p className="lede">This link is not valid. Please use the link in your booking email, or <Link href="/contact" style={{ textDecoration: "underline" }}>contact us</Link>.</p></div></section>
    );
  }
  const settings = await loadBookingSettings(db);
  const providers = availableProviders(settings);
  const c = await chargeForBooking(db, b); // the same server calculation the payment endpoints use
  const charge = c.ok ? c.charge : null;
  const plan = charge && providers.length ? paymentPlan(settings.payment, charge.totalCents, b.amount_paid_cents ?? 0) : null;
  const closed = b.status === "cancelled" || b.status === "no_show" || b.status === "rejected";
  const released = Boolean(b.payment_released_at && b.driver_id); // approve-then-pay: no payment before approval + driver assignment
  const status = String(b.payment_status);
  const retry = status === "failed" || status === "unpaid" || status === "pending";

  return (
    <>
      <section className="page-head">
        <div className="container">
          <h1>Pay for your booking</h1>
          <p className="lede">Reference <strong>{b.reference}</strong>{b.pickup_at ? ` · pickup ${formatPickup(b.pickup_at, BUSINESS_TZ)}` : ""}</p>
        </div>
      </section>
      <section className="section">
        <div className="container" style={{ maxWidth: 760 }}>
          {back === "return" && <div className="notice" role="status">Thank you. We confirm payments with our payment provider before showing them as paid. If this page still says payment is pending, check again in a minute or two. Returning to this page does not itself mark anything as paid.</div>}
          {back === "cancelled" && <div className="notice" role="status">The payment was not completed and you have not been charged. You can try again below.</div>}
          <section className="panel-dark" aria-label="Price breakdown" style={{ marginTop: "1.5rem" }}>
            <h2 style={{ fontSize: "1.4rem" }}>What you pay online</h2>
            {charge ? (
              <table className="lines"><tbody>
                <tr><td>Fixed {charge.tierName} price</td><td>{formatMoney(charge.fixedPriceCents, b.currency)}</td></tr>
                {charge.rushCents > 0 && <tr><td>Rush-hour surcharge</td><td>{formatMoney(charge.rushCents, b.currency)}</td></tr>}
                {charge.tipCents > 0 && <tr><td>Driver tip</td><td>{formatMoney(charge.tipCents, b.currency)}</td></tr>}
                {charge.meetGreetCents > 0 && <tr><td>Airport Meet &amp; Greet</td><td>{formatMoney(charge.meetGreetCents, b.currency)}</td></tr>}
                {charge.addonsCents > 0 && <tr><td>Child car seats</td><td>{formatMoney(charge.addonsCents, b.currency)}</td></tr>}
                <tr className="total"><td>Total online amount</td><td>{formatMoney(charge.totalCents, b.currency)}</td></tr>
              </tbody></table>
            ) : <p className="muted">An online amount has not been set up for this booking.</p>}
            {b.estimated_fare_cents != null && <p className="muted" style={{ marginTop: "1rem" }}>Estimated trip fare: {formatMoney(b.estimated_fare_cents, b.currency)}. This estimate is for information only and is not included in the online amount above.</p>}
          </section>
          <dl className="kv" style={{ marginTop: "1.5rem" }}>
            <dt>Paid so far</dt><dd>{formatMoney(b.amount_paid_cents ?? 0, b.currency)}</dd>
            <dt>Payment status</dt><dd>{STATUS_TEXT[status] ?? status}</dd>
          </dl>
          {settings.payment.terms && <p className="muted" style={{ marginTop: "1rem" }}>{settings.payment.terms}</p>}
          {closed ? <div className="notice">This booking can no longer be paid online. Please contact us.</div>
            : !released ? <div className="notice" role="status">Your request is being reviewed. You have not been charged. We will email you when it is approved and a driver is assigned, and you can pay from this page then.</div>
            : plan && retry ? (
              <div style={{ marginTop: "1.5rem" }}>
                <p style={{ marginBottom: "1rem" }}>{plan.kind === "deposit" ? "Deposit due now: " : "Amount due now: "}<strong>{formatMoney(plan.amountCents, b.currency)}</strong></p>
                <PaymentChoice token={token} available={providers} paypalClientId={paypalClientId()} amountLabel={formatMoney(plan.amountCents, b.currency)} retry={status === "failed" || back === "cancelled"} />
                <p className="muted" style={{ marginTop: "1rem" }}>Paying does not confirm your booking by itself: we confirm it with you directly.</p>
              </div>
            ) : !plan && status !== "paid" && status !== "deposit_paid" ? <div className="notice">Online payment is not available for this booking right now. We will arrange payment with you directly.</div> : null}
          <p style={{ marginTop: "2rem" }}><Link href="/" className="btn btn--ghost">Back to home</Link></p>
        </div>
      </section>
    </>
  );
}
