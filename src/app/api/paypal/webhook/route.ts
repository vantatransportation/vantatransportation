import { json } from "@/lib/http";
import { getAdminClient } from "@/lib/supabase/admin";
import { paypalWebhookId, verifyWebhook } from "@/lib/paypal";
import { processPayPalEvent } from "@/lib/payments-server";

export const runtime = "nodejs";

/** PayPal webhook. Authenticity is verified with PayPal's verify-webhook-signature API before anything is processed. */
export async function POST(request: Request) {
  if (!paypalWebhookId()) return json({ error: "Webhook is not configured." }, 503);
  const raw = await request.text();
  let event: { id?: string; event_type?: string; resource?: Record<string, unknown> };
  try { event = JSON.parse(raw); } catch { return json({ error: "Invalid payload." }, 400); }
  const h = request.headers;
  const ok = await verifyWebhook({
    transmissionId: h.get("paypal-transmission-id") ?? "", transmissionTime: h.get("paypal-transmission-time") ?? "", certUrl: h.get("paypal-cert-url") ?? "",
    authAlgo: h.get("paypal-auth-algo") ?? "", transmissionSig: h.get("paypal-transmission-sig") ?? "",
  }, event);
  if (!ok) return json({ error: "Invalid signature." }, 400);
  if (!event.id || !event.event_type) return json({ error: "Invalid event." }, 400);
  const db = getAdminClient();
  if (!db) return json({ error: "Database unavailable." }, 503);
  try {
    const result = await processPayPalEvent(db, { id: event.id, type: event.event_type, resource: event.resource });
    return json({ received: true, result });
  } catch (e) {
    console.error("[paypal] event failed", event.event_type, e instanceof Error ? e.message : e);
    return json({ error: "Processing failed." }, 500); // PayPal will retry
  }
}
