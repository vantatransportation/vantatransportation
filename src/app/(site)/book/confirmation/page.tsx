import type { Metadata } from "next";
import Link from "next/link";
import ConfirmationDetails from "@/components/ConfirmationDetails";
import AuthorizeCardButton from "@/components/AuthorizeCardButton";
import { getAdminClient } from "@/lib/supabase/admin";
import { loadConfirmation } from "@/lib/confirmation";
import { trackingPath } from "@/lib/tracking-url";
import { formatMoney } from "@/lib/pricing/engine";

// The private booking token is in the URL: keep the page out of search engines and out of Referer headers.
export const metadata: Metadata = { title: "Booking request received", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Confirmation({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const rawRef = one(sp.ref);
  const ref = rawRef && /^VT-\d{3,10}$/.test(rawRef) ? rawRef : null;
  const card = one(sp.card);
  const rawToken = one(sp.t);
  const token = rawToken && TOKEN_RE.test(rawToken) ? rawToken : null;
  const db = token ? getAdminClient() : null;
  const view = token && db ? await loadConfirmation(db, token) : null;

  // The customer's own booking page, found by the private token: price, card step with a way to resume it, tracking ID and tracking link.
  if (token && view) {
    const track = trackingPath(view.trackingCode);
    const money = (c: number) => formatMoney(c, view.currency);
    return (
      <>
        <section className="page-head">
          <div className="container">
            <h1>{view.card === "paid" ? "Payment received" : view.card === "held" ? "Card authorized" : "Request received"}</h1>
            <p className="lede">Thank you. Your booking request has been saved and sent to us. It is a request, not yet a confirmed booking.</p>
          </div>
        </section>
        <section className="section">
          <div className="container" style={{ maxWidth: 760 }}>
            <p className="lede">Your reference: <strong style={{ color: "var(--white)", letterSpacing: ".05em" }}>{view.reference}</strong></p>

            {view.pricing && (
              <section className="panel-dark" aria-label="Price" style={{ marginTop: "1rem" }}>
                <table className="lines"><tbody>
                  <tr><td>Trip fare</td><td>{money(view.pricing.tripFareCents)}</td></tr>
                  {view.pricing.meetGreetCents > 0 && <tr><td>Airport Meet &amp; Greet</td><td>{money(view.pricing.meetGreetCents)}</td></tr>}
                  {view.pricing.childSeatCents > 0 && <tr><td>Child car seats</td><td>{money(view.pricing.childSeatCents)}</td></tr>}
                  <tr className="total"><td>Total</td><td>{money(view.pricing.totalCents)}</td></tr>
                </tbody></table>
              </section>
            )}

            <div style={{ marginTop: "1.5rem" }} aria-live="polite">
              {view.closed ? <div className="notice" role="status">This booking is no longer open for payment. Please contact us if you have questions.</div>
                : view.card === "paid" ? <div className="notice" role="status">Your payment was received and verified by our payment provider. We email you a confirmation.</div>
                : view.card === "held" ? <div className="notice" role="status">Your card is authorized. This is a hold, not a charge: nothing is taken until we approve your booking. If we cannot accept it, the hold is released.</div>
                : view.card === "pending" && card === "authorized" ? <div className="notice" role="status">Thank you. We are waiting for our payment provider to confirm your card hold. <Link href={`/book/confirmation?t=${token}&card=authorized`} style={{ textDecoration: "underline" }}>Check again</Link> in a minute. Returning to this page does not itself mark anything as paid.</div>
                : null}
              {!view.closed && view.card !== "paid" && view.card !== "held" && !(view.card === "pending" && card === "authorized") && (
                view.canAuthorize ? (
                  <div className="notice" role="status">
                    <p>{card === "cancelled" ? "You did not finish the card step, so no card is held. Your booking request is saved." : view.card === "failed" ? "The last card attempt did not go through, so no card is held. Your booking request is saved." : "Your booking request is saved. Add your card to hold it now."} Authorizing is a hold, not a charge: nothing is taken until we approve your booking.</p>
                    <p style={{ marginTop: "1rem" }}><AuthorizeCardButton token={token} label={view.card === "none" ? "Authorize your card" : "Try the card step again"} /></p>
                  </div>
                ) : view.payPath ? (
                  <div className="notice" role="status"><p>Your booking has been approved. Complete payment to confirm it.</p><p style={{ marginTop: "1rem" }}><Link className="btn btn--primary" href={view.payPath}>Pay for your booking</Link></p></div>
                ) : (
                  <div className="notice" role="status">No card is held. If we approve your booking we will email you a secure payment link, and it is confirmed once that payment is received and verified.</div>
                )
              )}
            </div>

            {track && view.trackingCode && (
              <section className="panel-dark" aria-label="Tracking" style={{ marginTop: "1.5rem" }}>
                <h2 style={{ fontSize: "1.2rem" }}>Track your ride</h2>
                <p>Your tracking ID: <Link href={track} style={{ textDecoration: "underline", fontWeight: 700, letterSpacing: ".05em" }}>{view.trackingCode}</Link></p>
                <p className="muted" style={{ marginTop: ".4rem" }}>Select the tracking ID or the button to open your ride directly. Keep it private: anyone who has it can see this booking&apos;s progress. We also email it to you, and you can always enter it on the <Link href="/track" style={{ textDecoration: "underline" }}>Track Your Ride</Link> page.</p>
                <p style={{ marginTop: "1rem" }}><Link className="btn btn--primary" href={track}>Track Your Ride</Link></p>
              </section>
            )}

            <ol className="steps" style={{ gridTemplateColumns: "1fr", marginTop: "2rem" }}>
              <li><h3>We review your request</h3><p>We check availability for your date, time, vehicle and location. Anything you requested, such as airport Meet &amp; Greet, is confirmed separately.</p></li>
              <li><h3>We contact you to confirm</h3><p>If you authorized your card, we capture the payment when we approve your booking; otherwise we email you a secure payment link. Your booking is confirmed only when payment is received and verified, and we then email you a confirmation.</p></li>
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
