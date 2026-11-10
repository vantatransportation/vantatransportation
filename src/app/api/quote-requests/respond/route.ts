import { json, clientIp, readJson, sameOrigin } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getAdminClient } from "@/lib/supabase/admin";
import { notify } from "@/lib/notify";
import { formatMoney } from "@/lib/pricing/engine";

export const runtime = "nodejs";

/** Customer accepts or declines a revised quote using the private link we sent them. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!rateLimit(`qresp:${clientIp(request)}`, 10, 10 * 60_000)) return json({ error: "Too many requests." }, 429);
  const body = await readJson(request);
  const token = typeof body?.token === "string" ? body.token : "";
  const action = body?.action === "accept" ? "accept" : body?.action === "reject" ? "reject" : null;
  if (!/^[0-9a-f]{32,64}$/.test(token) || !action) return json({ error: "Invalid request." }, 400);

  const db = getAdminClient();
  if (!db) return json({ error: "Temporarily unavailable." }, 503);

  const { data: q } = await db.from("quote_requests").select("id,name,status,customer_response,revised_price_cents").eq("access_token", token).maybeSingle();
  if (!q) return json({ error: "This link is not valid." }, 404);
  if (q.status !== "revised_sent" || q.customer_response !== "pending") return json({ error: "This quote has already been answered or is no longer open." }, 409);

  const accepted = action === "accept";
  const upd = await db.from("quote_requests").update({
    customer_response: accepted ? "accepted" : "rejected", status: accepted ? "accepted" : "rejected", customer_responded_at: new Date().toISOString(),
  }).eq("id", q.id).eq("customer_response", "pending");
  if (upd.error) return json({ error: "We could not record your response. Please try again." }, 500);

  await db.from("activity_logs").insert({ action: accepted ? "quote.accepted" : "quote.rejected", entity_type: "quote_request", entity_id: q.id, meta: {} });
  await notify(db, "quote.responded", { type: "quote_request", id: q.id }, {
    Customer: q.name, Response: accepted ? "Accepted" : "Declined", "Revised price": q.revised_price_cents != null ? formatMoney(q.revised_price_cents) : "",
  });
  return json({ ok: true, response: accepted ? "accepted" : "rejected" });
}
