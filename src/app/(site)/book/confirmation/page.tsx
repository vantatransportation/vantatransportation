import type { Metadata } from "next";
import Link from "next/link";
import ConfirmationDetails from "@/components/ConfirmationDetails";
import ConfirmationLive from "@/components/ConfirmationLive";
import { getAdminClient } from "@/lib/supabase/admin";
import { loadConfirmation } from "@/lib/confirmation";
import { trackingPath } from "@/lib/tracking-url";

// The private booking token is in the URL: keep the page out of search engines and out of Referer headers.
export const metadata: Metadata = { title: "Your booking", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Confirmation({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const rawRef = one(sp.ref);
  const ref = rawRef && /^VT-\d{3,10}$/.test(rawRef) ? rawRef : null;
  const rawToken = one(sp.t);
  const token = rawToken && TOKEN_RE.test(rawToken) ? rawToken : null;
  const db = token ? getAdminClient() : null;
  const view = token && db ? await loadConfirmation(db, token) : null;

  // The customer's own booking page, found by the private token. This is the payment step right after Book (save the card), the status page while the
  // request awaits approval, and the page where the customer reviews and confirms once approved. No payment link is involved at any stage.
  if (token && view) {
    const track = trackingPath(view.trackingCode);
    return (
      <>
        <section className="page-head">
          <div className="container">
            <h1>{view.trip.stage === "card_needed" ? "Complete your booking request" : view.trip.stage === "confirmed" ? "Booking confirmed" : "Your booking"}</h1>
            <p className="lede">{view.trip.stage === "confirmed" ? "Your booking is confirmed and paid." : "Your trip is saved. This is a request, not yet a confirmed booking."}</p>
          </div>
        </section>
        <section className="section">
          <div className="container" style={{ maxWidth: 760 }}>
            <p className="lede">Your reference: <strong style={{ color: "var(--white)", letterSpacing: ".05em" }}>{view.trip.reference}</strong></p>
            <div style={{ marginTop: "1rem" }}><ConfirmationLive token={token} initial={view.trip} /></div>

            {track && view.trackingCode && (
              <section className="panel-dark" aria-label="Tracking" style={{ marginTop: "1.5rem" }}>
                <h2 style={{ fontSize: "1.2rem" }}>Track your ride</h2>
                <p>Your tracking number: <Link href={track} style={{ textDecoration: "underline", fontWeight: 700, letterSpacing: ".05em" }}>{view.trackingCode}</Link></p>
                <p className="muted" style={{ marginTop: ".4rem" }}>Select the tracking number or the button to open your ride directly. Keep it private: anyone who has it can see this booking&apos;s progress. We also email it to you, and you can always enter it on the <Link href="/track" style={{ textDecoration: "underline" }}>Track Your Ride</Link> page.</p>
                <p style={{ marginTop: "1rem" }}><Link className="btn btn--primary" href={track}>Track Your Ride</Link></p>
              </section>
            )}

            <ol className="steps" style={{ gridTemplateColumns: "1fr", marginTop: "2rem" }}>
              <li><h3>1. You save a card</h3><p>Your card is saved securely with Stripe for this booking only. Nothing is charged and no funds are held.</p></li>
              <li><h3>2. We review and approve</h3><p>We check availability for your date, time, vehicle and location. Approval alone does not charge you or confirm the ride.</p></li>
              <li><h3>3. You confirm</h3><p>After approval you review the total here and press Confirm Booking &amp; Authorize Charge. Only then is your saved card charged.</p></li>
              <li><h3>4. Your booking is confirmed</h3><p>Once the payment is verified your booking is confirmed, and we assign your driver and email you the details.</p></li>
            </ol>
            <p style={{ marginTop: "2rem" }}><Link href="/" className="btn btn--ghost">Back to home</Link></p>
          </div>
        </section>
      </>
    );
  }

  // Older links (by reference) keep working: the details come from this browser's own session, never from the reference.
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
          {token && !view && <p className="notice notice--error" role="alert">This link is not valid. Please use the link in your booking email, or <Link href="/contact" style={{ textDecoration: "underline" }}>contact us</Link>.</p>}
          {ref && <p className="lede">Your reference: <strong style={{ color: "var(--white)", letterSpacing: ".05em" }}>{ref}</strong></p>}
          {ref && <ConfirmationDetails reference={ref} />}
          <ol className="steps" style={{ gridTemplateColumns: "1fr", marginTop: "2rem" }}>
            <li><h3>We review your request</h3><p>We check availability for your date, time, vehicle and location. Anything you requested, such as airport Meet &amp; Greet, is confirmed separately.</p></li>
            <li><h3>You confirm, then your booking is confirmed</h3><p>When we approve your request you review it and confirm on your booking page. Nothing is charged until you confirm, and your booking is confirmed once the payment is verified. Keep your reference handy, and contact us if you need anything before then.</p></li>
          </ol>
          <p style={{ marginTop: "2rem" }}><Link href="/" className="btn btn--ghost">Back to home</Link></p>
        </div>
      </section>
    </>
  );
}
