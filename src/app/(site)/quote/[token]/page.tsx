import type { Metadata } from "next";
import { notFound } from "next/navigation";
import QuoteResponse from "@/components/QuoteResponse";
import { getAdminClient } from "@/lib/supabase/admin";
import { formatMoney } from "@/lib/pricing/engine";
import { formatPickup } from "@/lib/geo/time";
import { BUSINESS_TZ } from "@/lib/config";

export const metadata: Metadata = { title: "Your revised quote", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function QuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{32,64}$/.test(token)) notFound();
  const db = getAdminClient();
  if (!db) notFound();
  const { data: q } = await db.from("quote_requests").select("name,status,customer_response,revised_price_cents,original_quote_cents,trip,vehicles(name)").eq("access_token", token).maybeSingle();
  if (!q) notFound();

  const t = (q.trip as { trip?: { pickup: { text: string }; dropoff: { text: string }; pickupAtIso: string; passengers: number } } | null)?.trip;
  const open = q.status === "revised_sent" && q.customer_response === "pending" && q.revised_price_cents != null;
  const vehicle = (q.vehicles as unknown as { name?: string } | null)?.name;

  return (
    <>
      <section className="page-head"><div className="container"><h1>Your revised quote</h1><p className="lede">Hello {q.name}. Here is our response to your request.</p></div></section>
      <section className="section">
        <div className="container" style={{ maxWidth: 760 }}>
          {q.revised_price_cents != null && (
            <p className="lede">Revised price: <strong style={{ color: "var(--white)", fontSize: "1.6rem" }}>{formatMoney(q.revised_price_cents)}</strong>
              {q.original_quote_cents != null && <span className="muted"> (original estimate {formatMoney(q.original_quote_cents)})</span>}</p>
          )}
          {t && (
            <dl className="kv-dark" style={{ margin: "1.5rem 0" }}>
              {vehicle && <><dt>Vehicle</dt><dd>{vehicle}</dd></>}
              <dt>Pickup</dt><dd>{t.pickup.text}</dd><dt>Destination</dt><dd>{t.dropoff.text}</dd>
              <dt>When</dt><dd>{formatPickup(t.pickupAtIso, BUSINESS_TZ)}</dd><dt>Passengers</dt><dd>{t.passengers}</dd>
            </dl>
          )}
          {open ? <QuoteResponse token={token} /> : (
            <div className="notice">{q.customer_response === "accepted" ? "You accepted this quote. We will be in touch to finalize your booking." : q.customer_response === "rejected" ? "You declined this quote." : "This quote is not open for a response right now. We will contact you shortly."}</div>
          )}
          <p className="muted" style={{ marginTop: "1.5rem" }}>No payment is taken online. Accepting lets us proceed with your booking request.</p>
        </div>
      </section>
    </>
  );
}
