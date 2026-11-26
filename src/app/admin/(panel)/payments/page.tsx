import Link from "next/link";
import { fmtDate, fmtMoney } from "@/components/admin/util";
import { adminPage } from "@/lib/admin/data";
import { BUSINESS_TZ } from "@/lib/config";
import { loadBookingSettings } from "@/lib/policies";
import { stripeConfigured, webhookSecret } from "@/lib/stripe";
import { paypalConfigured, paypalEnv, paypalWebhookId } from "@/lib/paypal";

export const metadata = { title: "Payments" };
export const dynamic = "force-dynamic";

type P = {
  id: string; booking_id: string; provider: string; provider_ref: string | null; provider_txn_id: string | null; status: string; kind: string;
  amount_cents: number; refunded_cents: number; currency: string; tier_name: string | null; fixed_price_cents: number | null;
  meet_greet_cents: number; other_addons_cents: number; estimated_trip_fare_cents: number | null; created_at: string; paid_at: string | null; failure_reason: string | null;
};

export default async function Payments() {
  const { db } = await adminPage();
  const [settings, payQ] = await Promise.all([
    loadBookingSettings(db),
    db.from("payments").select("id,booking_id,provider,provider_ref,provider_txn_id,status,kind,amount_cents,refunded_cents,currency,tier_name,fixed_price_cents,meet_greet_cents,other_addons_cents,estimated_trip_fare_cents,created_at,paid_at,failure_reason").order("created_at", { ascending: false }).limit(200),
  ]);
  const rows = (payQ.data ?? []) as P[];
  const ids = [...new Set(rows.map((r) => r.booking_id))];
  const refs = new Map<string, string>();
  if (ids.length) {
    const { data } = await db.from("bookings").select("id,reference").in("id", ids);
    for (const b of (data ?? []) as { id: string; reference: string }[]) refs.set(b.id, b.reference);
  }
  // Collected = provider-confirmed payments only, net of refunds. Pending, failed and expired attempts never count.
  const collected = rows.filter((r) => r.paid_at).reduce((n, r) => n + r.amount_cents - r.refunded_cents, 0);
  const stripeOn = settings.payment.mode !== "disabled" && settings.stripeEnabled && stripeConfigured();
  const paypalOn = settings.payment.mode !== "disabled" && settings.paypalEnabled && paypalConfigured();

  return (
    <>
      <h1>Payments</h1>
      <p className="adm-sub">Actual online payments confirmed by Stripe or PayPal. Each amount is the complete booking total: tier fixed fee + trip estimate + Meet &amp; Greet + child seats. Customers see only the combined trip fare (fixed fee + estimate), the services and the total.</p>

      <div className="twocol">
        <div className="panel">
          <h3>Card payments (Stripe)</h3>
          <p><strong>{stripeOn ? "Available to customers" : "Not offered to customers"}</strong></p>
          <ul className="muted">
            <li>Server keys: {stripeConfigured() ? "STRIPE_SECRET_KEY set" : "STRIPE_SECRET_KEY missing"}; {webhookSecret() ? "webhook secret set" : "STRIPE_WEBHOOK_SECRET missing (payments cannot be confirmed)"}</li>
            <li>Switch in Booking settings: {settings.stripeEnabled ? "on" : "off"}</li>
          </ul>
        </div>
        <div className="panel">
          <h3>PayPal</h3>
          <p><strong>{paypalOn ? "Available to customers" : "Not offered to customers"}</strong></p>
          <ul className="muted">
            <li>Credentials: {paypalConfigured() ? `PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET set (${paypalEnv()} mode)` : "PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing"}</li>
            <li>Webhook: {paypalWebhookId() ? "PAYPAL_WEBHOOK_ID set" : "PAYPAL_WEBHOOK_ID not set (captures are still verified when the customer returns, but delayed or refund notices will not arrive)"}</li>
            <li>Switch in Booking settings: {settings.paypalEnabled ? "on" : "off"}</li>
          </ul>
        </div>
      </div>
      {settings.payment.mode === "disabled" && <div className="notice">Online payment is set to <strong>disabled</strong> in <Link href="/admin/booking-settings">Booking settings</Link>, so no provider is offered. Set the three fixed prices under <Link href="/admin/tiers">Tier prices &amp; fees</Link> first.</div>}

      <div className="panel">
        <h3>Collected online</h3>
        <p style={{ fontSize: "1.6rem" }}>{fmtMoney(collected)}</p>
        <p className="muted">Provider-confirmed payments, net of refunds. Secret keys are never shown here.</p>
      </div>

      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Date</th><th>Booking</th><th>Provider</th><th>Tier</th><th>Fixed fee (internal)</th><th>Trip estimate (internal)</th><th>Meet &amp; Greet</th><th>Seats</th><th>Charged</th><th>Status</th><th>Reference</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={11} className="muted">No payment attempts yet.</td></tr>}
            {rows.map((p) => (
              <tr key={p.id}>
                <td>{fmtDate(p.paid_at ?? p.created_at, BUSINESS_TZ)}</td>
                <td><Link href={`/admin/bookings/${p.booking_id}`}>{refs.get(p.booking_id) ?? "Booking"}</Link></td>
                <td>{p.provider === "paypal" ? "PayPal" : "Card (Stripe)"}</td>
                <td>{p.tier_name ?? ""}</td>
                <td>{p.fixed_price_cents != null ? fmtMoney(p.fixed_price_cents) : ""}</td>
                <td>{p.estimated_trip_fare_cents != null ? fmtMoney(p.estimated_trip_fare_cents) : ""}</td>
                <td>{p.meet_greet_cents > 0 ? fmtMoney(p.meet_greet_cents) : ""}</td>
                <td>{p.other_addons_cents > 0 ? fmtMoney(p.other_addons_cents) : ""}</td>
                <td>{fmtMoney(p.amount_cents)}{p.refunded_cents > 0 ? ` (refunded ${fmtMoney(p.refunded_cents)})` : ""}{p.kind === "deposit" ? " deposit" : ""}</td>
                <td>{p.status}{p.failure_reason ? ` · ${p.failure_reason}` : ""}</td>
                <td><code>{p.provider_txn_id ?? p.provider_ref ?? ""}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
