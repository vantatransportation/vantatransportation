import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";
import { notify } from "@/lib/notify";
import { formatMoney } from "@/lib/pricing/engine";

export const runtime = "nodejs";

/**
 * Publishes the revised quote to the customer via a private link and emails it through Brevo.
 * The link is also shown to the admin so it can be shared another way if the email cannot be sent.
 */
export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const body = await readJson(request);
  const id = typeof body?.id === "string" ? body.id : "";
  const { data: q } = await g.db.from("quote_requests").select("id,name,email,phone,status,revised_price_cents,discount_decision,access_token,converted_booking_id,revised_history").eq("id", id).maybeSingle();
  if (!q) return json({ error: "Quote request not found." }, 404);
  if (q.converted_booking_id) return json({ error: "This quote was already converted to a booking." }, 409);
  if (q.revised_price_cents == null) return json({ error: "Enter a revised price and save before sending." }, 422);

  const upd = await g.db.from("quote_requests").update({
    status: "revised_sent", customer_response: "pending", revised_sent_at: new Date().toISOString(),
    revised_history: [...(Array.isArray(q.revised_history) ? q.revised_history : []), { priceCents: q.revised_price_cents, sentAt: new Date().toISOString(), by: g.admin.email }] as never,
    discount_decision: q.discount_decision === "pending" ? "approved" : q.discount_decision,
  }).eq("id", q.id);
  if (upd.error) return json({ error: "Could not update the quote." }, 500);

  const base = (process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/$/, "");
  const link = `${base}/quote/${q.access_token}`;
  let emailStatus = "No email address on file. Share the link manually.";
  if (q.email) {
    const sentAt = String(Date.now());
    await notify(g.db, "quote.revised_sent", { type: "quote_request", id: q.id }, { Customer: q.name, "Revised price": formatMoney(q.revised_price_cents), Link: link, _customerEmail: q.email, _customerName: q.name }, { dedupeSuffix: sentAt });
    const last = await g.db.from("notification_logs").select("status,error").eq("entity_id", q.id).eq("event", "quote.revised_sent").order("created_at", { ascending: false }).limit(1).maybeSingle();
    emailStatus = last.data?.status === "sent" ? "Email sent to the customer." : `Email ${last.data?.status ?? "not sent"}${last.data?.error ? `: ${last.data.error}` : ""}. You can retry it under Notifications.`;
  }
  await g.db.from("activity_logs").insert({ actor_id: g.admin.id, action: "quote.revised_sent", entity_type: "quote_request", entity_id: q.id, meta: {} });
  return json({ ok: true, link, emailStatus, email: q.email });
}
