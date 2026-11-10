import { NextResponse } from "next/server";
import { clientIp, readJson, sameOrigin } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getPublicClient } from "@/lib/supabase/public";
import { getAdminClient } from "@/lib/supabase/admin";
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieOptions } from "@/lib/admin/auth";

export const runtime = "nodejs";
const fail = () => NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!rateLimit(`login:${clientIp(request)}`, 8, 10 * 60_000)) return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });

  const body = await readJson(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase().slice(0, 200) : "";
  const password = typeof body?.password === "string" ? body.password.slice(0, 200) : "";
  if (!email || !password) return fail();

  const anon = getPublicClient();
  const db = getAdminClient();
  if (!anon || !db) return NextResponse.json({ error: "Sign-in is not configured yet. See the README." }, { status: 503 });

  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) return fail();

  // Valid credentials are not enough: the user must be listed in admin_users.
  const admin = await db.from("admin_users").select("user_id").eq("user_id", data.user.id).maybeSingle();
  if (!admin.data) return fail();

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, data.session.access_token, cookieOptions(data.session.expires_in ?? 3600));
  res.cookies.set(REFRESH_COOKIE, data.session.refresh_token, cookieOptions(60 * 60 * 24 * 7));
  await db.from("activity_logs").insert({ actor_id: data.user.id, action: "admin.login", entity_type: "admin", meta: {} });
  return res;
}
