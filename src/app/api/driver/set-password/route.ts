import { NextResponse } from "next/server";
import { clientIp, readJson, sameOrigin } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getAdminClient } from "@/lib/supabase/admin";
import { getPublicClient } from "@/lib/supabase/public";
import { DRIVER_ACCESS_COOKIE, DRIVER_REFRESH_COOKIE } from "@/lib/driver/auth";
import { cookieOptions } from "@/lib/admin/auth";

export const runtime = "nodejs";
const reply = (error: string, status: number, code: string) => NextResponse.json({ error, code }, { status });

/**
 * Completes a driver invitation (or password reset): the browser sends the short-lived token from the emailed link.
 * The token is verified with Supabase Auth and must belong to a user linked to an ACTIVE driver record; nothing else can use this.
 *  - `{ accessToken, check: true }` only verifies the link, so the page can show a clear message before asking for a password.
 *  - `{ accessToken, password }` sets the password, then signs the driver in (same cookies as /api/driver/login) so they land on /driver.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return reply("Forbidden", 403, "forbidden");
  const body = await readJson(request);
  const check = body?.check === true;
  const limited = check ? rateLimit(`driver-setpw-check:${clientIp(request)}`, 30, 10 * 60_000) : rateLimit(`driver-setpw:${clientIp(request)}`, 10, 10 * 60_000);
  if (!limited) return reply("Too many attempts. Try again in a few minutes.", 429, "rate_limited");
  const token = typeof body?.accessToken === "string" ? body.accessToken.slice(0, 4000) : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!token) return reply("This link is not valid. Ask Vanta to send a new invitation.", 400, "missing_token");
  if (!check && (password.length < 10 || password.length > 128)) return reply("Choose a password of at least 10 characters.", 422, "weak_password");
  const db = getAdminClient();
  if (!db) return reply("Not configured.", 503, "not_configured");
  const { data, error } = await db.auth.getUser(token);
  if (error) {
    // Supabase unreachable or erroring is not the same as a bad link: do not tell the driver their link expired.
    if (error.name === "AuthRetryableFetchError" || (error.status ?? 0) >= 500) { console.error("[driver-setpw] auth service unavailable", error.message); return reply("We could not reach the sign-in service. Please try again in a moment.", 503, "unavailable"); }
    return reply("This link has expired or was already used. Ask Vanta to send a new invitation.", 401, "expired");
  }
  if (!data.user) return reply("This link has expired or was already used. Ask Vanta to send a new invitation.", 401, "expired");
  const d = await db.from("drivers").select("id,is_active").eq("user_id", data.user.id).maybeSingle();
  if (d.error) { console.error("[driver-setpw] drivers lookup failed", d.error.message); return reply("Could not check your driver account. Try again shortly.", 500, "lookup_failed"); }
  if (!d.data || d.data.is_active === false) return reply("This account is not an active driver account. Please contact Vanta.", 403, "not_driver");
  if (check) return NextResponse.json({ ok: true });

  const up = await db.auth.admin.updateUserById(data.user.id, { password });
  if (up.error) { console.error("[driver-setpw] update failed", up.error.message); return reply("Could not set the password. Try again.", 500, "update_failed"); }
  await db.from("activity_logs").insert({ actor_id: data.user.id, action: "driver.password_set", entity_type: "driver", entity_id: d.data.id, meta: {} });

  // Establish the driver session now, so the driver goes straight to the dashboard. If that fails the password is still set and they can sign in.
  let session: { access_token: string; refresh_token: string; expires_in?: number } | null = null;
  const anon = getPublicClient();
  if (anon && data.user.email) {
    try {
      const s = await anon.auth.signInWithPassword({ email: data.user.email, password });
      if (!s.error && s.data.session) session = s.data.session;
    } catch (e) { console.error("[driver-setpw] sign-in after set failed", e); }
  }
  const res = NextResponse.json({ ok: true, signedIn: !!session });
  if (session) {
    res.cookies.set(DRIVER_ACCESS_COOKIE, session.access_token, cookieOptions(session.expires_in ?? 3600));
    res.cookies.set(DRIVER_REFRESH_COOKIE, session.refresh_token, cookieOptions(60 * 60 * 24 * 7));
  }
  return res;
}
