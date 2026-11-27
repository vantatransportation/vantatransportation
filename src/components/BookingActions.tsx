"use client";

import Link from "next/link";
import { useState } from "react";
import CardSetupStep from "@/components/CardSetupStep";
import { cardChargeConsentText } from "@/lib/card-consent";
import { loadStripeJs } from "@/lib/stripe-client";
import { credBody, postJson, type ClientCredential } from "@/lib/customer-client";
import { formatMoney } from "@/lib/pricing/engine";
import type { TripView } from "@/lib/trip";

const cardLabel = (c: TripView["card"]) => (c ? `${(c.brand ?? "Card").toUpperCase()} ending ${c.last4}` : "");

/**
 * What the customer can DO about their booking right now, driven by the server-derived stage:
 *  - save a card (nothing charged, nothing held),
 *  - after admin approval: review the total and press "Confirm Booking & Authorize Charge" (their explicit consent),
 *  - finish their bank's authentication, or retry / use another card after a decline.
 * Every button calls a server endpoint that re-checks approval, the card and the amount. This component never sends or decides an amount.
 */
export default function BookingActions({ cred, trip, onRefresh }: { cred: ClientCredential; trip: TripView; onRefresh: () => void }) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [swap, setSwap] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const c = trip.charges;
  const total = c ? formatMoney(c.totalCents, c.currency) : "";
  const key = trip.publicKey ?? "";

  async function authenticate(clientSecret: string) {
    try {
      const stripe = await loadStripeJs(key);
      const r = await stripe.handleNextAction({ clientSecret }); // Stripe's own bank-authentication step (3-D Secure / SCA)
      if (r.error) setMsg({ kind: "error", text: r.error.message ?? "Your bank could not authenticate this payment. You have not been charged. Please try again." });
    } catch (e) { setMsg({ kind: "error", text: (e as Error).message }); }
    const f = await postJson("/api/bookings/confirm/finalize", credBody(cred)); // the server re-checks with Stripe: only its verified result counts
    show(f);
  }
  function show(r: { ok: boolean; data: Record<string, unknown> }) {
    const d = r.data;
    if (!r.ok) setMsg({ kind: "error", text: String(d.error ?? "That did not work. You have not been charged. Please try again.") });
    else if (d.state === "paid") setMsg({ kind: "ok", text: "Payment received and verified. Your booking is confirmed." });
    else if (d.state === "processing") setMsg({ kind: "info", text: String(d.message ?? "Your payment is processing. This page updates when it is verified. Please do not pay again.") });
    onRefresh();
  }
  async function confirm() {
    if (busy) return;
    if (!consent) return setMsg({ kind: "error", text: "Please tick the box to confirm your booking and authorize the charge." });
    setBusy(true); setMsg(null);
    try {
      const r = await postJson("/api/bookings/confirm", { ...credBody(cred), consent: true });
      if (r.ok && r.data.state === "requires_action" && typeof r.data.clientSecret === "string") await authenticate(r.data.clientSecret);
      else show(r);
    } catch { setMsg({ kind: "error", text: "Could not reach the server. You have not been charged twice; please refresh this page to see the latest status." }); }
    setBusy(false);
  }
  const saved = () => { setSwap(false); setMsg({ kind: "ok", text: "Your card was saved. Nothing has been charged and no funds are held." }); onRefresh(); };
  const alert = <div role="status" aria-live="polite">{msg && <div className={`notice ${msg.kind === "error" ? "notice--error" : ""}`} style={{ marginTop: "1rem" }}>{msg.text}</div>}</div>;

  switch (trip.stage) {
    case "card_needed":
      return (
        <section className="panel" aria-label="Save your card" style={{ marginTop: "1rem" }}>
          <h3>Step 2: Save your card to complete your request</h3>
          <p className="muted">Your trip is saved. Add a card so we can process your request. <strong>No charge is made and no funds are held now.</strong> If we approve your booking you will be asked to confirm it; only then is the saved card charged{total ? ` the total (${total})` : ""}.</p>
          {trip.cardAvailable ? <CardSetupStep cred={cred} stripeKey={key} currency={c?.currency ?? "USD"} onSaved={saved} /> : <p className="notice">Card payment is not available right now. Your request is saved; we will contact you about payment.</p>}
          {alert}
        </section>
      );
    case "awaiting_approval":
      return (
        <section className="panel" aria-label="Awaiting approval" style={{ marginTop: "1rem" }}>
          <h3>Booking Request Received: Awaiting Admin Approval</h3>
          <p className="muted">No payment has been taken and no funds are on hold.{trip.card ? ` Your ${cardLabel(trip.card)} is saved securely for this booking.` : ""} We review your request; when it is approved you will be asked here to review and confirm it before your card is charged. This is a request, not yet a confirmed booking.</p>
        </section>
      );
    case "approved_card_needed":
    case "approved_ready":
    case "payment_failed": {
      const hasCard = Boolean(trip.card) && trip.stage !== "approved_card_needed";
      return (
        <section className="panel" aria-label="Confirm your booking" style={{ marginTop: "1rem" }}>
          <h3>{trip.stage === "payment_failed" ? "Your payment did not go through" : "Your booking is approved: please confirm"}</h3>
          <p className="muted">{trip.stage === "payment_failed" ? "You have not been charged. Try again, or use a different card." : "Nothing has been charged yet. Review the details and total above, then confirm. Your saved card is charged only when you press the button."}</p>
          {hasCard && !swap && trip.canConfirm && (
            <>
              <p>Card on file: <strong>{cardLabel(trip.card)}</strong> <button type="button" className="linkbtn" onClick={() => setSwap(true)}>Use a different card</button></p>
              <label className="choice"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>{cardChargeConsentText(total || "the total shown")}</span></label>
              <p style={{ marginTop: "1rem" }}><button type="button" className="btn btn--primary" onClick={confirm} disabled={busy}>{busy ? "Confirming…" : `Confirm Booking & Authorize Charge${total ? ` (${total})` : ""}`}</button></p>
            </>
          )}
          {(!hasCard || swap) && trip.canAddCard && <CardSetupStep cred={cred} stripeKey={key} currency={c?.currency ?? "USD"} onSaved={saved} submitLabel={swap ? "Save this card instead" : "Save my card"} />}
          {!trip.cardAvailable && <p className="notice">Card payment is not available right now. Please contact us.</p>}
          {trip.payable && cred.kind === "token" && <p className="muted" style={{ marginTop: "1rem" }}>Prefer PayPal? <Link href={`/pay/${cred.token}`} style={{ textDecoration: "underline" }}>Confirm and pay with PayPal instead</Link>.</p>}
          {alert}
        </section>
      );
    }
    case "action_required":
      return (
        <section className="panel" aria-label="Bank authentication" style={{ marginTop: "1rem" }}>
          <h3>Your bank needs you to authenticate the payment</h3>
          <p className="muted">Your booking is not confirmed and you have not been charged yet. Complete your bank&apos;s check to finish. Nothing is charged twice.</p>
          <p><button type="button" className="btn btn--primary" onClick={confirm} disabled={busy}>{busy ? "Opening your bank…" : "Complete authentication"}</button></p>
          <label className="choice"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>{cardChargeConsentText(total || "the total shown")}</span></label>
          {alert}
        </section>
      );
    case "processing":
      return (
        <section className="panel" aria-label="Payment processing" style={{ marginTop: "1rem" }}>
          <h3>Payment processing</h3>
          <p className="muted">Your payment was submitted and we are waiting for Stripe to verify it. Your booking is confirmed once it is. Please do not pay again.</p>
          <p><button type="button" className="btn btn--ghost" onClick={async () => { const f = await postJson("/api/bookings/confirm/finalize", credBody(cred)); show(f); }}>Check status</button></p>
          {alert}
        </section>
      );
    case "no_online_payment":
      return <section className="panel" aria-label="Payment" style={{ marginTop: "1rem" }}><h3>Your booking is approved</h3><p className="muted">An online amount was not set for this booking, so we will arrange payment with you directly. Nothing has been charged.</p></section>;
    case "review":
      return <section className="panel" aria-label="Payment" style={{ marginTop: "1rem" }}><h3>We are reviewing your payment</h3><p className="muted">Our team is checking a payment on this booking and will contact you. Please do not pay again.</p></section>;
    case "confirmed":
      return <section className="panel" aria-label="Confirmed" style={{ marginTop: "1rem" }}><h3>Booking confirmed and paid</h3><p className="muted">Payment was received and verified. {trip.driver ? "Your driver's details are shown on this page." : "We will email you your driver's details as soon as a driver is assigned."}</p></section>;
    default:
      return null;
  }
}
