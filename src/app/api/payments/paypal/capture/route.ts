import { json, clientIp, readJson, sameOrigin } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getAdminClient } from "@/lib/supabase/admin";
import { capturePayPal, validToken } from "@/lib/payments-server";

export const runtime = "nodejs";

/** Captures an approved PayPal order on the server and verifies it. The response says whether it is really paid. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!rateLimit(`paycap:${clientIp(request)}`, 20, 10 * 60_000)) return json({ error: "Too many attempts. Please wait a few minutes." }, 429);
  const body = await readJson(request);
  if (!validToken(body?.token) || typeof body?.orderId !== "string") return json({ error: "Invalid request." }, 400);
  const db = getAdminClient();
  if (!db) return json({ error: "Online payment is not available right now." }, 503);
  const r = await capturePayPal(db, body.token as string, body.orderId);
  return r.ok ? json({ ok: true, status: r.status }) : json({ error: r.error }, r.status);
}
