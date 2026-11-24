import { clientIp, json, readJson, sameOrigin } from "@/lib/http";
import { getAdminClient } from "@/lib/supabase/admin";
import { loadTrip } from "@/lib/trip";
import { rateDriver } from "@/lib/ratings";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  const { token } = await ctx.params;
  if (!rateLimit(`rate:t:${token}`, 10, 60_000) || !rateLimit(`rate:ip:${clientIp(request)}`, 30, 60_000)) return json({ error: "Too many requests. Wait a moment." }, 429);
  const db = getAdminClient();
  if (!db) return json({ error: "Not available." }, 503);
  const t = await loadTrip(db, token);
  if (!t) return json({ error: "Not found." }, 404);
  const body = await readJson(request);
  const r = await rateDriver(db, t.id, body?.stars, body?.feedback);
  return r.ok ? json({ ok: true }) : json({ error: r.error }, r.status);
}
