import { json, clientIp, readJson, sameOrigin } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { autocomplete, mapsConfigured } from "@/lib/geo/google";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!rateLimit(`ac:${clientIp(request)}`, 60, 60_000)) return json({ error: "Too many requests." }, 429);
  if (!mapsConfigured()) return json({ error: "not_configured", suggestions: [] }, 503);
  const body = await readJson(request);
  const input = typeof body?.input === "string" ? body.input.trim().slice(0, 200) : "";
  const token = typeof body?.sessionToken === "string" && /^[\w-]{8,64}$/.test(body.sessionToken) ? body.sessionToken : "none-session";
  if (input.length < 3) return json({ suggestions: [] });
  const suggestions = await autocomplete(input, token);
  return json({ suggestions: suggestions ?? [] });
}
