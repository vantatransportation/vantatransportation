import { clientIp, json, readJson, sameOrigin } from "@/lib/http";
import { getAdminClient } from "@/lib/supabase/admin";
import { authTracking, TRACK_HEADER } from "@/lib/track-auth";
import { listMessages, sendMessage } from "@/lib/chat-server";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Customer side of the driver chat, authorised by the tracking ID (header) and checked against the booking on every request. */
export async function GET(request: Request) {
  const db = getAdminClient();
  if (!db) return json({ error: "Not available." }, 503);
  const a = await authTracking(db, request, request.headers.get(TRACK_HEADER));
  if (a instanceof Response) return a;
  if (!a.view.driverId) return json({ error: "Not found." }, 404);
  const after = new URL(request.url).searchParams.get("after");
  return json({ messages: await listMessages(db, a.id, { role: "customer" }, after), open: a.view.view.chatOpen });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  const db = getAdminClient();
  if (!db) return json({ error: "Not available." }, 503);
  const a = await authTracking(db, request, request.headers.get(TRACK_HEADER));
  if (a instanceof Response) return a;
  if (!rateLimit(`chat:c:${a.id}`, 20, 60_000) || !rateLimit(`chat:ip:${clientIp(request)}`, 60, 60_000)) return json({ error: "You are sending messages too quickly. Wait a moment." }, 429);
  const body = await readJson(request);
  // The sender role is fixed by the credential (a tracking ID is always the customer); any role in the body is ignored.
  const r = await sendMessage(db, { id: a.id, status: a.view.view.status, driver_id: a.view.driverId }, "customer", body?.body, body?.clientId);
  return r.ok ? json({ message: r.message, duplicate: r.duplicate }) : json({ error: r.error }, r.status);
}
