import { json, clientIp, readJson, sameOrigin } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getAdminClient } from "@/lib/supabase/admin";
import { startCheckout, validToken } from "@/lib/payments-server";

export const runtime = "nodejs";

/** Starts a Stripe Checkout session for the booking identified by its private payment token. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!rateLimit(`pay:${clientIp(request)}`, 10, 10 * 60_000)) return json({ error: "Too many attempts. Please wait a few minutes." }, 429);
  const body = await readJson(request);
  if (!validToken(body?.token)) return json({ error: "Invalid payment link." }, 400);
  const db = getAdminClient();
  if (!db) return json({ error: "Online payment is not available right now." }, 503);
  const site = (process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/$/, "");
  const r = await startCheckout(db, body.token as string, site);
  return r.ok ? json({ ok: true, url: r.url }) : json({ error: r.error }, r.status);
}
