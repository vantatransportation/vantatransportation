import type { Metadata } from "next";
import Link from "next/link";
import PayButton from "@/components/PayButton";
import { getAdminClient } from "@/lib/supabase/admin";
import { loadBookingSettings } from "@/lib/policies";
import { paymentPlan } from "@/lib/payments";
import { stripeConfigured } from "@/lib/stripe";
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
  const { data: b } = db ? await db.from("bookings").select("reference,status,pickup_at,estimated_fare_cents,currency,amount_paid_cents,payment_status").eq("payment_token", token).maybeSingle() : { data: null };

  if (!db || !b) {
    return (
      <section className="page-head"><div className="container"><h1>Payment link not found</h1><p className="lede">This link is not valid. Please use the link in your booking email, or <Link href="/contact" style={{ textDecoration: "underline" }}>contact us</Link>.</p></div></section>
    );
  }
  const settings = await loadBookingSettings(db);
  const live = stripeConfigured();
  const plan = live ? paymentPlan(settings.payment, b.estimated_fare_cents, b.amount_paid_cents ?? 0) : null;
  const closed = b.status === "cancelled" || b.status === "no_show";
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
          <dl className="kv" style={{ marginTop: "1.5rem" }}>
            <dt>Estimated total</dt><dd>{b.estimated_fare_cents != null ? formatMoney(b.estimated_fare_cents, b.currency) : "To be confirmed"}</dd>
            <dt>Paid so far</dt><dd>{formatMoney(b.amount_paid_cents ?? 0, b.currency)}</dd>
            <dt>Payment status</dt><dd>{STATUS_TEXT[status] ?? status}</dd>
          </dl>
          {settings.payment.terms && <p className="muted" style={{ marginTop: "1rem" }}>{settings.payment.terms}</p>}
          {closed ? <div className="notice">This booking can no longer be paid online. Please contact us.</div>
            : plan && retry ? (
              <div style={{ marginTop: "1.5rem" }}>
                <p style={{ marginBottom: "1rem" }}>{plan.kind === "deposit" ? "Deposit due now: " : "Amount due now: "}<strong>{formatMoney(plan.amountCents, b.currency)}</strong></p>
                <PayButton token={token} label={status === "failed" || back === "cancelled" ? "Try payment again" : plan.kind === "deposit" ? "Pay deposit" : "Pay now"} />
                <p className="muted" style={{ marginTop: "1rem" }}>Payment is handled on Stripe&apos;s secure page. We never see or store your card number. Paying does not confirm your booking by itself: we confirm it with you directly.</p>
              </div>
            ) : !plan && status !== "paid" && status !== "deposit_paid" ? <div className="notice">Online payment is not available for this booking right now. We will arrange payment with you directly.</div> : null}
          <p style={{ marginTop: "2rem" }}><Link href="/" className="btn btn--ghost">Back to home</Link></p>
        </div>
      </section>
    </>
  );
}
