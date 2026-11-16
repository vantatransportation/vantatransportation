import "server-only";
import { centsToDecimal } from "@/lib/payments";

/** PayPal REST client (orders v2). Server only: the client secret never reaches a browser. */
export type PayPalEnv = "sandbox" | "live";
export const paypalEnv = (): PayPalEnv => (process.env.PAYPAL_ENV?.trim().toLowerCase() === "live" ? "live" : "sandbox");
const base = () => (paypalEnv() === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
export const paypalClientId = () => process.env.PAYPAL_CLIENT_ID?.trim() || "";
const secret = () => process.env.PAYPAL_CLIENT_SECRET?.trim() || "";
export const paypalConfigured = () => Boolean(paypalClientId() && secret());
export const paypalWebhookId = () => process.env.PAYPAL_WEBHOOK_ID?.trim() || "";

let cached: { token: string; exp: number; key: string } | null = null;
async function accessToken(): Promise<string> {
  const key = `${paypalEnv()}:${paypalClientId()}`;
  if (cached && cached.key === key && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch(`${base()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${paypalClientId()}:${secret()}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials", signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !data.access_token) throw new Error(`PayPal auth ${res.status}`);
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in ?? 300) * 1000, key };
  return data.access_token;
}

async function call(method: "GET" | "POST", path: string, body?: unknown, requestId?: string) {
  const token = await accessToken();
  const res = await fetch(`${base()}${path}`, {
    method, signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(requestId ? { "PayPal-Request-Id": requestId } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export interface OrderInput {
  amountCents: number; currency: string; bookingId: string; paymentId: string; reference: string; description: string;
  items: { name: string; amountCents: number }[]; requestId: string;
}

/** Creates the order. The amount is the server-calculated one; the browser only receives the order id. */
export async function createOrder(i: OrderInput): Promise<{ ok: true; orderId: string } | { ok: false; error: string }> {
  if (!paypalConfigured()) return { ok: false, error: "PayPal is not configured." };
  try {
    const cur = i.currency.toUpperCase();
    const r = await call("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: i.paymentId, custom_id: i.bookingId, invoice_id: `${i.reference}-${i.paymentId.slice(0, 8)}`, description: i.description.slice(0, 120),
        amount: { currency_code: cur, value: centsToDecimal(i.amountCents), breakdown: { item_total: { currency_code: cur, value: centsToDecimal(i.amountCents) } } },
        items: i.items.map((it) => ({ name: it.name.slice(0, 120), quantity: "1", unit_amount: { currency_code: cur, value: centsToDecimal(it.amountCents) }, category: "DIGITAL_GOODS" })),
      }],
      application_context: { shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" },
    }, i.requestId);
    if (!r.ok || !r.data?.id) return { ok: false, error: `PayPal ${r.status}: ${r.data?.message ?? "could not create the order"}` };
    return { ok: true, orderId: String(r.data.id) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `PayPal request failed: ${e.message}` : "PayPal request failed" };
  }
}

/** Captures an approved order. Idempotent via PayPal-Request-Id; an already-captured order is re-read instead. */
export async function captureOrder(orderId: string, requestId: string): Promise<{ ok: true; order: unknown } | { ok: false; error: string }> {
  try {
    const r = await call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, requestId);
    if (r.ok) return { ok: true, order: r.data };
    if (r.status === 422 && JSON.stringify(r.data).includes("ORDER_ALREADY_CAPTURED")) {
      const g = await call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
      if (g.ok) return { ok: true, order: g.data };
    }
    return { ok: false, error: `PayPal ${r.status}: ${r.data?.message ?? "capture failed"}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `PayPal request failed: ${e.message}` : "PayPal request failed" };
  }
}

export interface WebhookHeaders { transmissionId: string; transmissionTime: string; certUrl: string; authAlgo: string; transmissionSig: string }
/** Asks PayPal to verify a webhook's signature. Returns false on any doubt. */
export async function verifyWebhook(h: WebhookHeaders, event: unknown): Promise<boolean> {
  if (!paypalConfigured() || !paypalWebhookId()) return false;
  try {
    const r = await call("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: h.authAlgo, cert_url: h.certUrl, transmission_id: h.transmissionId, transmission_sig: h.transmissionSig,
      transmission_time: h.transmissionTime, webhook_id: paypalWebhookId(), webhook_event: event,
    });
    return r.ok && r.data?.verification_status === "SUCCESS";
  } catch {
    return false;
  }
}
