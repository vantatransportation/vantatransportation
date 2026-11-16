import { json, clientIp, readJson, sameOrigin } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getAdminClient } from "@/lib/supabase/admin";
import { startCheckout, validToken } from "@/lib/payments-server";

export const runtime = "nodejs";

/**
 * Starts a payment with the provider the customer chose ("stripe" = card via Stripe Checkout, or "paypal").
 * The browser supplies only the private booking token and the provider: the amount is calculated on the server.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!rateLimit(`pay:${clientIp(request)}`, 15, 10 * 60_000)) return json({ error: "Too many attempts. Please wait a few minutes." }, 429);
  const body = await readJson(request);
  if (!validToken(body?.token)) return json({ error: "Invalid payment link." }, 400);
  if (body?.provider !== "stripe" && body?.provider !== "paypal") return json({ error: "Choose a payment method." }, 400);
  const db = getAdminClient();
  if (!db) return json({ error: "Online payment is not available right now." }, 503);
  const site = (process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/$/, "");
  const r = await startCheckout(db, body.token as string, body.provider, site);
  if (!r.ok) return json({ error: r.error }, r.status);
  return r.provider === "stripe" ? json({ ok: true, provider: "stripe", url: r.url }) : json({ ok: true, provider: "paypal", orderId: r.orderId });
}
