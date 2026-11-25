import type { Metadata } from "next";
import Link from "next/link";
import ConfirmationDetails from "@/components/ConfirmationDetails";

export const metadata: Metadata = { title: "Booking request received", robots: { index: false } };

export default async function Confirmation({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.ref) ? sp.ref[0] : sp.ref;
  const ref = raw && /^VT-\d{3,10}$/.test(raw) ? raw : null;
  const card = Array.isArray(sp.card) ? sp.card[0] : sp.card;
  return (
    <>
      <section className="page-head">
        <div className="container">
          <h1>Request received</h1>
          <p className="lede">Thank you. Your booking request has been saved and sent to us. It is a request, not yet a confirmed booking.</p>
        </div>
      </section>
      <section className="section">
        <div className="container" style={{ maxWidth: 760 }}>
          {card === "authorized" && <p className="notice" role="status">Your card has been authorized. This is a hold, not a charge: nothing is taken until we approve your booking.</p>}
          {card === "cancelled" && <p className="notice" role="status">You did not complete the card step, so no card is held. Your booking request is saved. If we approve it, we will email you a secure payment link.</p>}
          {ref && <p className="lede">Your reference: <strong style={{ color: "var(--white)", letterSpacing: ".05em" }}>{ref}</strong></p>}
          {ref && <ConfirmationDetails reference={ref} />}
          <ol className="steps" style={{ gridTemplateColumns: "1fr", marginTop: "2rem" }}>
            <li><h3>We review your request</h3><p>We check availability for your date, time, vehicle and location. Anything you requested, such as airport Meet &amp; Greet, is confirmed separately.</p></li>
            <li><h3>We contact you to confirm</h3><p>Nothing has been charged. If you authorized your card, we capture the payment when we approve your booking; otherwise we email you a secure payment link. Your booking is confirmed only when payment is received and verified, and we then email you a confirmation. Keep your reference handy, and contact us if you need anything before then.</p></li>
          </ol>
          <p style={{ marginTop: "2rem" }}><Link href="/" className="btn btn--ghost">Back to home</Link></p>
        </div>
      </section>
    </>
  );
}
