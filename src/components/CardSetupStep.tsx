"use client";

import { useEffect, useRef, useState } from "react";
import { CARD_SAVE_CONSENT_TEXT } from "@/lib/card-consent";
import { loadStripeJs, type StripeElement, type StripeElements, type StripeJs } from "@/lib/stripe-client";
import { credBody, postJson, type ClientCredential } from "@/lib/customer-client";

/**
 * Saves the customer's card for THIS booking with Stripe Elements (the Payment Element). Nothing is charged and no funds are held.
 * The card is typed into Stripe's own form; this component never sees it. The card counts as saved only after the SERVER verifies the SetupIntent with Stripe.
 */
export default function CardSetupStep({ cred, stripeKey, currency, onSaved, submitLabel = "Save my card" }: { cred: ClientCredential; stripeKey: string; currency: string; onSaved: () => void; submitLabel?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<StripeJs | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const [consent, setConsent] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false; let el: StripeElement | null = null;
    loadStripeJs(stripeKey).then((stripe) => {
      if (cancelled || !box.current) return;
      stripeRef.current = stripe;
      // Deferred mode: the form appears at once; the SetupIntent is created only when the customer has ticked the consent and presses the button.
      const elements = stripe.elements({ mode: "setup", currency: currency.toLowerCase(), setupFutureUsage: "off_session", paymentMethodTypes: ["card"], appearance: { theme: "night", variables: { colorPrimary: "#c9ccd1" } } });
      elementsRef.current = elements;
      el = elements.create("payment", { layout: "tabs" });
      el.mount(box.current);
      el.on("ready", () => setReady(true));
      setReady(true);
    }).catch((e: Error) => setError(e.message));
    return () => { cancelled = true; try { el?.destroy(); } catch { /* ignore */ } };
  }, [stripeKey, currency]);

  async function save() {
    if (busy || !stripeRef.current || !elementsRef.current) return;
    if (!consent) return setError("Please tick the box to allow us to save your card for this booking.");
    setBusy(true); setError("");
    try {
      const sub = await elementsRef.current.submit();
      if (sub.error) { setError(sub.error.message ?? "Please check your card details."); return setBusy(false); }
      const s = await postJson("/api/bookings/card/setup", { ...credBody(cred), consent: true });
      if (!s.ok || typeof s.data.clientSecret !== "string") { setError(String(s.data.error ?? "We could not open the secure card form. You have not been charged.")); return setBusy(false); }
      const here = cred.kind === "token" ? `${location.origin}/book/confirmation?t=${encodeURIComponent(cred.token)}&setup=return` : `${location.origin}/track#id=${encodeURIComponent(cred.code)}`;
      const r = await stripeRef.current.confirmSetup({ elements: elementsRef.current, clientSecret: s.data.clientSecret, confirmParams: { return_url: here }, redirect: "if_required" });
      if (r.error) { setError(r.error.message ?? "Your card could not be saved. You have not been charged."); return setBusy(false); }
      const c = await postJson("/api/bookings/card/complete", credBody(cred)); // the server checks with Stripe; this call proves nothing by itself
      if (!c.ok) { setError(String(c.data.error ?? "We could not confirm that your card was saved. You have not been charged. Please try again.")); return setBusy(false); }
      onSaved();
    } catch {
      setError("Could not reach the server. You have not been charged. Please try again.");
    }
    setBusy(false);
  }

  return (
    <div className="cardstep">
      <div ref={box} aria-label="Secure card entry" aria-busy={!ready} style={{ minHeight: 120 }} />
      <label className="choice" style={{ marginTop: "1rem" }}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>{CARD_SAVE_CONSENT_TEXT}</span>
      </label>
      <p style={{ marginTop: "1rem" }}><button type="button" className="btn btn--primary" onClick={save} disabled={busy || !ready}>{busy ? "Saving your card securely…" : submitLabel}</button></p>
      <p className="muted" style={{ marginTop: ".5rem" }}>Your card details go straight to Stripe. We never see or store your card number. No charge is made and no funds are held now.</p>
      <div role="alert" aria-live="polite">{error && <div className="notice notice--error" style={{ marginTop: "1rem" }}>{error}</div>}</div>
    </div>
  );
}
