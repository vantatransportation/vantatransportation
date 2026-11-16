import { NextResponse } from "next/server";
import { clientIp, readJson, sameOrigin } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getPublicClient } from "@/lib/supabase/public";
import { getAdminClient, serviceKeyProblem } from "@/lib/supabase/admin";
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieOptions } from "@/lib/admin/auth";

export const runtime = "nodejs";

const reply = (error: string, status: number, code: string) => NextResponse.json({ error, code }, { status });
/** Only for genuinely wrong credentials (or an unknown email: the two are deliberately indistinguishable). */
const badCredentials = () => reply("Incorrect email or password.", 401, "invalid_credentials");

/** Maps a Supabase Auth error to a precise response. Never echoes raw provider text to the browser. */
function authFailure(error: { code?: string; status?: number; name?: string; message?: string }) {
  const code = error.code ?? "";
  const status = error.status ?? 0;
  if (code === "invalid_credentials" || code === "user_not_found" || (status === 400 && /invalid login credentials/i.test(error.message ?? ""))) return badCredentials();
  if (code === "email_not_confirmed" || /email not confirmed/i.test(error.message ?? "")) {
    return reply("This account's email address has not been confirmed in Supabase. Confirm the user in Supabase, Authentication, Users, then try again.", 403, "email_not_confirmed");
  }
  if (code === "user_banned") return reply("This account has been disabled in Supabase.", 403, "user_banned");
  if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit" || status === 429) {
    return reply("Supabase is rate-limiting sign-in attempts. Try again in a few minutes.", 429, "provider_rate_limited");
  }
  // Anything else (invalid API key, unreachable project, 5xx, network failure) is a configuration/service problem, not a password problem.
  console.error("[admin-login] Supabase Auth failure:", { code, status, name: error.name, message: error.message });
  return reply("Sign-in service error. Check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY on the server (details are in the server log).", 502, "auth_service_error");
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return reply("Forbidden", 403, "forbidden");
  if (!rateLimit(`login:${clientIp(request)}`, 8, 10 * 60_000)) return reply("Too many attempts. Try again in a few minutes.", 429, "rate_limited");

  const body = await readJson(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase().slice(0, 200) : "";
  const password = typeof body?.password === "string" ? body.password.slice(0, 200) : "";
  if (!email || !password) return reply("Enter your email and password.", 400, "missing_fields");

  const anon = getPublicClient();
  const db = getAdminClient();
  if (!anon || !db) return reply("Sign-in is not configured yet. See the README.", 503, "not_configured");
  const keyProblem = serviceKeyProblem();
  if (keyProblem) {
    console.error("[admin-login] SUPABASE_SERVICE_ROLE_KEY problem:", keyProblem);
    return reply(`Server configuration error: ${keyProblem}`, 503, "bad_service_key");
  }

  let signIn;
  try {
    signIn = await anon.auth.signInWithPassword({ email, password });
  } catch (e) {
    console.error("[admin-login] Supabase Auth request threw:", e);
    return reply("Could not reach the sign-in service. Try again shortly.", 502, "auth_unreachable");
  }
  const { data, error } = signIn;
  if (error) return authFailure(error);
  if (!data.session || !data.user) return reply("Sign-in did not return a session. Try again.", 502, "no_session");

  // Credentials are valid. Authorization is a separate check: the user must be listed in admin_users.
  const admin = await db.from("admin_users").select("user_id").eq("user_id", data.user.id).maybeSingle();
  if (admin.error) {
    console.error("[admin-login] admin_users lookup failed:", { code: admin.error.code, message: admin.error.message });
    const missingTable = admin.error.code === "42P01" || admin.error.code === "PGRST205";
    return reply(
      missingTable
        ? "Database is not set up: the admin_users table is missing. Run the SQL migrations in supabase/migrations (see README)."
        : "Database error while checking administrator access. Check SUPABASE_SERVICE_ROLE_KEY and the server log.",
      500,
      missingTable ? "admin_table_missing" : "admin_lookup_failed",
    );
  }
  if (!admin.data) {
    console.warn("[admin-login] authenticated user is not in admin_users:", data.user.id);
    return reply(
      "Your password is correct, but this account is not authorized as an administrator. Add it to the admin_users table in Supabase (README, step 2: Admin account).",
      403,
      "not_admin",
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, data.session.access_token, cookieOptions(data.session.expires_in ?? 3600));
  res.cookies.set(REFRESH_COOKIE, data.session.refresh_token, cookieOptions(60 * 60 * 24 * 7));
  await db.from("activity_logs").insert({ actor_id: data.user.id, action: "admin.login", entity_type: "admin", meta: {} });
  return res;
}
