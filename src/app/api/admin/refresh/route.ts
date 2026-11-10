import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getPublicClient } from "@/lib/supabase/public";
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieOptions } from "@/lib/admin/auth";

export const runtime = "nodejs";

/** Silent session refresh: exchanges the refresh cookie for new tokens, then returns to the dashboard. */
export async function GET(request: Request) {
  const store = await cookies();
  const refresh = store.get(REFRESH_COOKIE)?.value;
  const anon = getPublicClient();
  const toLogin = () => {
    const res = NextResponse.redirect(new URL("/admin/login", request.url));
    res.cookies.set(ACCESS_COOKIE, "", cookieOptions(0));
    res.cookies.set(REFRESH_COOKIE, "", cookieOptions(0));
    return res;
  };
  if (!refresh || !anon) return toLogin();
  const { data, error } = await anon.auth.refreshSession({ refresh_token: refresh });
  if (error || !data.session) return toLogin();
  const res = NextResponse.redirect(new URL("/admin", request.url));
  res.cookies.set(ACCESS_COOKIE, data.session.access_token, cookieOptions(data.session.expires_in ?? 3600));
  res.cookies.set(REFRESH_COOKIE, data.session.refresh_token, cookieOptions(60 * 60 * 24 * 7));
  return res;
}
