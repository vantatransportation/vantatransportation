import { clientIp, json, readJson, sameOrigin } from "@/lib/http";
import { getAdminClient } from "@/lib/supabase/admin";
import { loadTrip } from "@/lib/trip";
import { listMessages, sendMessage } from "@/lib/chat-server";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const db = getAdminClient();
  if (!db) return json({ error: "Not available." }, 503);
  const t = await loadTrip(db, token);
  if (!t || !t.driverId) return json({ error: "Not found." }, 404);
  const after = new URL(request.url).searchParams.get("after");
  return json({ messages: await listMessages(db, t.id, { role: "customer" }, after), open: t.view.chatOpen });
}

export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  const { token } = await ctx.params;
  if (!rateLimit(`chat:c:${token}`, 20, 60_000) || !rateLimit(`chat:ip:${clientIp(request)}`, 60, 60_000)) return json({ error: "You are sending messages too quickly. Wait a moment." }, 429);
  const db = getAdminClient();
  if (!db) return json({ error: "Not available." }, 503);
  const t = await loadTrip(db, token);
  if (!t) return json({ error: "Not found." }, 404);
  const body = await readJson(request);
  const r = await sendMessage(db, { id: t.id, status: t.view.status, driver_id: t.driverId }, "customer", body?.body, body?.clientId);
  return r.ok ? json({ message: r.message, duplicate: r.duplicate }) : json({ error: r.error }, r.status);
}
