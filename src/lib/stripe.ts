import "server-only";

/**
 * Minimal Stripe client over the REST API (no SDK, so there is nothing extra to install). Server only.
 *
 * Saved-card workflow (see docs/SAVED_CARD_WORKFLOW.md):
 *   Customer + SetupIntent (card saved at booking, nothing charged or held)  ->  later, after admin approval AND the customer's explicit
 *   confirmation, a PaymentIntent for the saved card. Card numbers never reach this server: Stripe.js in the browser sends them to Stripe.
 */
const API = "https://api.stripe.com/v1";
export const stripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY?.trim());
export const webhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET?.trim() || "";
/** The publishable key is public by design (it can only create tokens in the browser). Read at request time so no rebuild is needed to change it. */
export const publishableKey = () => process.env.STRIPE_PUBLISHABLE_KEY?.trim() || process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim() || "";

type Fail = { ok: false; code: string; error: string; pi?: StripePI };
type Obj = Record<string, unknown>;

async function call<T>(method: "GET" | "POST", path: string, body?: URLSearchParams, idempotencyKey?: string): Promise<{ ok: true; data: T } | Fail> {
  if (!stripeConfigured()) return { ok: false, code: "not_configured", error: "Stripe is not configured." };
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      body: method === "POST" ? body ?? new URLSearchParams() : undefined, signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & { id?: string; error?: { message?: string; code?: string; decline_code?: string; payment_intent?: StripePI } };
    if (!res.ok || !(data as { id?: string }).id) {
      const e = (data as { error?: { message?: string; code?: string; decline_code?: string; payment_intent?: StripePI } }).error;
      return { ok: false, code: e?.decline_code ?? e?.code ?? `http_${res.status}`, error: e?.message ?? `Stripe returned ${res.status}`, pi: e?.payment_intent };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, code: "network", error: e instanceof Error ? e.message : "Stripe request failed" };
  }
}

// ---------------------------------------------------------------- Customer
export async function createCustomer(i: { email?: string; name?: string; bookingId: string; idempotencyKey: string }): Promise<{ ok: true; id: string } | Fail> {
  const b = new URLSearchParams({ "metadata[booking_id]": i.bookingId });
  if (i.email) b.set("email", i.email);
  if (i.name) b.set("name", i.name.slice(0, 120));
  const r = await call<{ id: string }>("POST", "/customers", b, i.idempotencyKey);
  return r.ok ? { ok: true, id: r.data.id } : r;
}

// ---------------------------------------------------------------- SetupIntent: save the card WITHOUT charging or holding anything
export interface StripeSetupIntent {
  id: string; status: string; client_secret?: string; customer?: string | null; usage?: string;
  payment_method?: { id: string; customer?: string | null; card?: { brand?: string; last4?: string } } | string | null;
  metadata?: Record<string, string>; last_setup_error?: { message?: string } | null;
}

export async function createSetupIntent(i: { customerId: string; bookingId: string; idempotencyKey: string }): Promise<{ ok: true; si: StripeSetupIntent } | Fail> {
  const b = new URLSearchParams({
    customer: i.customerId, "payment_method_types[0]": "card",
    // Saved for later use by us, with the customer's consent (recorded on the booking). Stripe runs any authentication (SCA/3-D Secure) NOW, while the customer is present.
    usage: "off_session", "metadata[booking_id]": i.bookingId, description: "Vanta Transportation: card saved for this booking (no charge, no hold)",
  });
  const r = await call<StripeSetupIntent>("POST", "/setup_intents", b, i.idempotencyKey);
  return r.ok ? { ok: true, si: r.data } : r;
}

export async function retrieveSetupIntent(id: string): Promise<{ ok: true; si: StripeSetupIntent } | Fail> {
  const r = await call<StripeSetupIntent>("GET", `/setup_intents/${encodeURIComponent(id)}?expand[]=payment_method`);
  return r.ok ? { ok: true, si: r.data } : r;
}

/** Best effort: removes a saved card from its Stripe customer (declined/cancelled bookings, or when a card is replaced). Never throws. */
export async function detachPaymentMethod(id: string): Promise<boolean> {
  const r = await call<Obj>("POST", `/payment_methods/${encodeURIComponent(id)}/detach`);
  return r.ok;
}

// ---------------------------------------------------------------- PaymentIntent
export interface StripePI {
  id: string; status: string; amount: number; amount_capturable?: number; amount_received?: number; currency: string; cancellation_reason?: string | null;
  client_secret?: string; customer?: string | null; payment_method?: string | { id: string } | null; metadata?: Record<string, string>;
  last_payment_error?: { message?: string; code?: string; decline_code?: string } | null;
  latest_charge?: { payment_method_details?: { card?: { brand?: string; last4?: string; capture_before?: number } } } | string | null;
}
const authHeader = () => ({ Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` });

/** Reads a PaymentIntent from Stripe: the source of truth for what is actually charged. */
export async function retrievePaymentIntent(id: string): Promise<{ ok: true; pi: StripePI } | { ok: false; error: string }> {
  if (!stripeConfigured()) return { ok: false, error: "Stripe is not configured." };
  try {
    const res = await fetch(`${API}/payment_intents/${encodeURIComponent(id)}?expand[]=latest_charge`, { headers: authHeader(), signal: AbortSignal.timeout(15_000) });
    const data = (await res.json().catch(() => ({}))) as StripePI & { error?: { message?: string } };
    if (!res.ok || !data.id) return { ok: false, error: `Stripe ${res.status}: ${data.error?.message ?? "could not read the payment"}` };
    return { ok: true, pi: data };
  } catch (e) { return { ok: false, error: e instanceof Error ? `Stripe request failed: ${e.message}` : "Stripe request failed" }; }
}

export interface ChargeInput {
  amountCents: number; currency: string; customerId: string; paymentMethodId: string; bookingId: string; paymentId: string;
  returnUrl: string; description: string; idempotencyKey: string;
}

/**
 * Charges the saved card for the booking total. Called ONLY after the server verified admin approval, the customer's explicit confirmation
 * and the authoritative amount. The customer is present (they just clicked Confirm), so this is an ON-SESSION payment: if the bank asks for
 * authentication, Stripe returns requires_action and the browser completes it with stripe.handleNextAction. Nothing is marked paid here:
 * the caller records a payment only from Stripe's verified result.
 */
export async function createSavedCardCharge(i: ChargeInput): Promise<{ ok: true; pi: StripePI } | Fail> {
  const b = new URLSearchParams({
    amount: String(i.amountCents), currency: i.currency.toLowerCase(), customer: i.customerId, payment_method: i.paymentMethodId,
    "payment_method_types[0]": "card", confirm: "true", return_url: i.returnUrl, description: i.description.slice(0, 200),
    "metadata[booking_id]": i.bookingId, "metadata[payment_id]": i.paymentId, "metadata[kind]": "saved_card_charge",
  });
  const r = await call<StripePI>("POST", "/payment_intents", b, i.idempotencyKey);
  return r.ok ? { ok: true, pi: r.data } : r;
}

/** Releases an uncaptured hold (legacy "authorize now" bookings only). Best effort; the caller records the outcome. */
export async function cancelPaymentIntent(id: string): Promise<boolean> {
  const r = await call<Obj>("POST", `/payment_intents/${encodeURIComponent(id)}/cancel`, new URLSearchParams({ cancellation_reason: "requested_by_customer" }), `cancel-${id}`);
  return r.ok;
}
