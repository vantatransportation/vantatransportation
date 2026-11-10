import { json } from "@/lib/http";
import { getAdminClient } from "@/lib/supabase/admin";
import { verifyStripeSignature } from "@/lib/stripe-signature";
import { webhookSecret } from "@/lib/stripe";
import { processStripeEvent } from "@/lib/payments-server";

export const runtime = "nodejs";

/** Stripe webhook. The signature is verified against the RAW body before anything is read or written. */
export async function POST(request: Request) {
  const secret = webhookSecret();
  if (!secret) return json({ error: "Webhook is not configured." }, 503);
  const raw = await request.text();
  if (!verifyStripeSignature(raw, request.headers.get("stripe-signature"), secret)) return json({ error: "Invalid signature." }, 400);
  let event: { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
  try { event = JSON.parse(raw); } catch { return json({ error: "Invalid payload." }, 400); }
  if (!event.id || !event.type || !event.data?.object) return json({ error: "Invalid event." }, 400);
  const db = getAdminClient();
  if (!db) return json({ error: "Database unavailable." }, 503);
  try {
    const result = await processStripeEvent(db, event as never);
    return json({ received: true, result });
  } catch (e) {
    console.error("[stripe] event failed", event.type, e instanceof Error ? e.message : e);
    return json({ error: "Processing failed." }, 500); // Stripe will retry
  }
}
