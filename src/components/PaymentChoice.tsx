"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface PayPalButtons { render: (el: HTMLElement) => Promise<void>; close?: () => void }
interface PayPalSdk { Buttons: (o: Record<string, unknown>) => PayPalButtons }
declare global { interface Window { paypal?: PayPalSdk } }

let sdkPromise: Promise<PayPalSdk> | null = null;
/** Loads PayPal's official JavaScript SDK once. The client id is public; the secret never reaches the browser. */
function loadPayPal(clientId: string): Promise<PayPalSdk> {
  if (window.paypal) return Promise.resolve(window.paypal);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons`;
    s.async = true;
    s.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error("PayPal did not load")));
    s.onerror = () => { sdkPromise = null; reject(new Error("PayPal could not be loaded")); };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

type Provider = "paypal";
const post = async (url: string, body: object) => {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, data: await res.json().catch(() => ({})) as Record<string, unknown> };
};

/** Lets the customer pick Card (Stripe) or PayPal, whichever the server says is available. Amounts are never sent from here. */
export default function PaymentChoice({ token, available, paypalClientId, amountLabel, retry }: { token: string; available: Provider[]; paypalClientId: string; amountLabel: string; retry: boolean }) {
  const router = useRouter();
  const [choice, setChoice] = useState<Provider | null>(available.length === 1 ? available[0] : null); // only auto-selected when it is the sole option
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (choice !== "paypal" || !box.current) return;
    let cancelled = false;
    const el = box.current; el.innerHTML = "";
    loadPayPal(paypalClientId).then((sdk) => {
      if (cancelled) return;
      return sdk.Buttons({
        style: { layout: "vertical", shape: "rect", label: "pay" },
        createOrder: async () => {
          setMsg(null);
          const r = await post("/api/payments/checkout", { token, provider: "paypal" });
          if (!r.ok || typeof r.data.orderId !== "string") { const m = String(r.data.error ?? "PayPal is unavailable right now."); setMsg({ kind: "error", text: m }); throw new Error(m); }
          return r.data.orderId;
        },
        onApprove: async (data: { orderID: string }) => {
          setBusy(true);
          const r = await post("/api/payments/paypal/capture", { token, orderId: data.orderID });
          setBusy(false);
          if (!r.ok) return setMsg({ kind: "error", text: String(r.data.error ?? "We could not confirm the PayPal payment.") });
          setMsg({ kind: r.data.status === "paid" ? "ok" : "info", text: r.data.status === "paid" ? "Payment received. Thank you." : "PayPal is still processing this payment. This page will show it as paid once PayPal confirms." });
          router.refresh();
        },
        onCancel: () => setMsg({ kind: "info", text: "PayPal payment cancelled. You have not been charged." }),
        onError: () => setMsg((m) => m ?? { kind: "error", text: "PayPal ran into a problem. You have not been charged. Please try again." }),
      }).render(el);
    }).catch(() => setMsg({ kind: "error", text: "PayPal could not be loaded. Please try again, or choose another way to pay." }));
    return () => { cancelled = true; el.innerHTML = ""; };
  }, [choice, token, paypalClientId, router]);

  if (available.length === 0) return <div className="notice">Online payment is not available for this booking right now. We will arrange payment with you directly.</div>;
  return (
    <fieldset className="fieldset paychoice">
      <legend>Pay with PayPal{retry ? " (try again)" : ""}</legend>
      <div className="choices">
        {available.includes("paypal") && (
          <label className="choice"><input type="radio" name="provider" checked={choice === "paypal"} onChange={() => { setChoice("paypal"); setMsg(null); }} />
            <span><strong>PayPal</strong><br /><small className="muted">Pay with your PayPal account or the cards saved in it.</small></span></label>
        )}
      </div>
      {choice === "paypal" && <div ref={box} className="paychoice__paypal" aria-busy={busy} />}
      {choice === null && <p className="muted" style={{ marginTop: ".75rem" }}>Select a payment method to continue.</p>}
      <div role="alert" aria-live="polite">{msg && <div className={`notice ${msg.kind === "error" ? "notice--error" : msg.kind === "ok" ? "notice--ok" : ""}`} style={{ marginTop: "1rem" }}>{msg.text}</div>}</div>
    </fieldset>
  );
}
