import "server-only";

/** Minimal Stripe Checkout client over the REST API (no SDK, so there is nothing extra to install). Server only. */
const API = "https://api.stripe.com/v1";
export const stripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY?.trim());
export const webhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET?.trim() || "";

export interface CheckoutInput {
  amountCents: number; currency: string; lines: { name: string; amountCents: number }[]; successUrl: string; cancelUrl: string;
  bookingId: string; paymentId: string; customerEmail?: string; idempotencyKey: string;
}
export type CheckoutResult = { ok: true; id: string; url: string } | { ok: false; error: string };

async function stripe(path: string, body: URLSearchParams, idempotencyKey?: string) {
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body, signal: AbortSignal.timeout(15_000),
  });
}

export async function createCheckoutSession(i: CheckoutInput): Promise<CheckoutResult> {
  if (!stripeConfigured()) return { ok: false, error: "Online payment is not configured." };
  const b = new URLSearchParams({
    mode: "payment", // Payment methods are chosen dynamically from the Stripe Dashboard settings (payment_method_types is no longer supported).
    success_url: i.successUrl, cancel_url: i.cancelUrl, client_reference_id: i.bookingId,
    "metadata[booking_id]": i.bookingId, "metadata[payment_id]": i.paymentId,
    "payment_intent_data[metadata][booking_id]": i.bookingId, "payment_intent_data[metadata][payment_id]": i.paymentId,
    expires_at: String(Math.floor(Date.now() / 1000) + 3600),
  });
  // One Checkout line per charged component; they must add up to the amount the server calculated.
  if (i.lines.reduce((n, l) => n + l.amountCents, 0) !== i.amountCents) return { ok: false, error: "Line items do not add up to the amount." };
  i.lines.forEach((l, n) => {
    b.set(`line_items[${n}][quantity]`, "1"); b.set(`line_items[${n}][price_data][currency]`, i.currency.toLowerCase());
    b.set(`line_items[${n}][price_data][unit_amount]`, String(l.amountCents)); b.set(`line_items[${n}][price_data][product_data][name]`, l.name.slice(0, 120));
  });
  if (i.customerEmail) b.set("customer_email", i.customerEmail);
  try {
    const res = await stripe("/checkout/sessions", b, i.idempotencyKey);
    const data = (await res.json().catch(() => ({}))) as { id?: string; url?: string; error?: { message?: string } };
    if (!res.ok || !data.id || !data.url) return { ok: false, error: `Stripe ${res.status}: ${data.error?.message ?? "could not create a payment session"}` };
    return { ok: true, id: data.id, url: data.url };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `Stripe request failed: ${e.message}` : "Stripe request failed" };
  }
}

/** Best effort: stops an older unpaid session from being completed after a new one is created. */
export async function expireCheckoutSession(id: string): Promise<void> {
  try { await stripe(`/checkout/sessions/${encodeURIComponent(id)}/expire`, new URLSearchParams()); } catch { /* ignore */ }
}
