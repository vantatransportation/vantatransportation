import { NextResponse } from "next/server";
import { clientIp, readJson, sameOrigin } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getPublicClient } from "@/lib/supabase/public";
import { getAdminClient } from "@/lib/supabase/admin";
import { DRIVER_ACCESS_COOKIE, DRIVER_REFRESH_COOKIE } from "@/lib/driver/auth";
import { cookieOptions } from "@/lib/admin/auth";

export const runtime = "nodejs";
const reply = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(request: Request) {
  if (!sameOrigin(request)) return reply("Forbidden", 403);
  if (!rateLimit(`driver-login:${clientIp(request)}`, 8, 10 * 60_000)) return reply("Too many attempts. Try again in a few minutes.", 429);
  const body = await readJson(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase().slice(0, 200) : "";
  const password = typeof body?.password === "string" ? body.password.slice(0, 200) : "";
  if (!email || !password) return reply("Enter your email and password.", 400);
  const anon = getPublicClient(), db = getAdminClient();
  if (!anon || !db) return reply("Sign-in is not configured yet.", 503);

  let signIn;
  try { signIn = await anon.auth.signInWithPassword({ email, password }); } catch (e) { console.error("[driver-login] auth request threw", e); return reply("Could not reach the sign-in service. Try again shortly.", 502); }
  if (signIn.error || !signIn.data.session || !signIn.data.user) {
    const st = signIn.error?.status ?? 0;
    if (st === 429) return reply("Too many sign-in attempts. Try again in a few minutes.", 429);
    if (st >= 500) { console.error("[driver-login] auth service error", signIn.error?.message); return reply("Sign-in service error. Try again shortly.", 502); }
    return reply("Incorrect email or password.", 401);
  }
  // Authorization is separate from authentication: the account must be linked to an ACTIVE driver.
  const d = await db.from("drivers").select("id,is_active").eq("user_id", signIn.data.user.id).maybeSingle();
  if (d.error) { console.error("[driver-login] drivers lookup failed", d.error.message); return reply("Could not check your driver account. Try again shortly.", 500); }
  if (!d.data || d.data.is_active === false) return reply("This account is not an active driver account. Please contact Vanta.", 403);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(DRIVER_ACCESS_COOKIE, signIn.data.session.access_token, cookieOptions(signIn.data.session.expires_in ?? 3600));
  res.cookies.set(DRIVER_REFRESH_COOKIE, signIn.data.session.refresh_token, cookieOptions(60 * 60 * 24 * 7));
  await db.from("activity_logs").insert({ actor_id: signIn.data.user.id, action: "driver.login", entity_type: "driver", entity_id: d.data.id, meta: {} });
  return res;
}
