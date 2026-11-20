import { json, clientIp, readJson, sameOrigin } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Completes a driver invitation: the browser sends the short-lived token from the invitation link and a new password.
 * The token is verified with Supabase Auth and must belong to a user linked to a driver record; nothing else can use this.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!rateLimit(`driver-setpw:${clientIp(request)}`, 10, 10 * 60_000)) return json({ error: "Too many attempts. Try again in a few minutes." }, 429);
  const body = await readJson(request);
  const token = typeof body?.accessToken === "string" ? body.accessToken.slice(0, 4000) : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!token) return json({ error: "This link is not valid. Ask Vanta to send a new invitation." }, 400);
  if (password.length < 10 || password.length > 128) return json({ error: "Choose a password of at least 10 characters." }, 422);
  const db = getAdminClient();
  if (!db) return json({ error: "Not configured." }, 503);
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return json({ error: "This link has expired. Ask Vanta to send a new invitation." }, 401);
  const d = await db.from("drivers").select("id,is_active").eq("user_id", data.user.id).maybeSingle();
  if (!d.data || d.data.is_active === false) return json({ error: "This account is not an active driver account." }, 403);
  const up = await db.auth.admin.updateUserById(data.user.id, { password });
  if (up.error) { console.error("[driver-setpw] update failed", up.error.message); return json({ error: "Could not set the password. Try again." }, 500); }
  return json({ ok: true });
}
