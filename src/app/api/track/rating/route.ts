import { clientIp, json, readJson, sameOrigin } from "@/lib/http";
import { getAdminClient } from "@/lib/supabase/admin";
import { authTracking, TRACK_HEADER } from "@/lib/track-auth";
import { rateDriver } from "@/lib/ratings";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Customer rates THEIR OWN completed ride, authorised by the tracking ID (header). The booking comes from the credential, never from the body. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  const db = getAdminClient();
  if (!db) return json({ error: "Not available." }, 503);
  const a = await authTracking(db, request, request.headers.get(TRACK_HEADER));
  if (a instanceof Response) return a;
  if (!rateLimit(`rate:${a.id}`, 10, 60_000) || !rateLimit(`rate:ip:${clientIp(request)}`, 30, 60_000)) return json({ error: "Too many requests. Wait a moment." }, 429);
  const body = await readJson(request);
  const r = await rateDriver(db, a.id, body?.stars, body?.feedback);
  return r.ok ? json({ ok: true }) : json({ error: r.error }, r.status);
}
