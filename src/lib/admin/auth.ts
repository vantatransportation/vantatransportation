import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAdminClient } from "@/lib/supabase/admin";

export const ACCESS_COOKIE = "vt_at";
export const REFRESH_COOKIE = "vt_rt";

export interface AdminUser { id: string; email: string }
export type AuthState = { status: "ok"; user: AdminUser } | { status: "expired" } | { status: "none" };

export const cookieOptions = (maxAgeSeconds: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: maxAgeSeconds,
});

/** Validates the session cookie against Supabase Auth and the admin_users table. Server-side only. */
export async function getAuthState(): Promise<AuthState> {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  const db = getAdminClient();
  if (!db) return { status: "none" };
  if (!token) return { status: store.get(REFRESH_COOKIE)?.value ? "expired" : "none" };

  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return { status: store.get(REFRESH_COOKIE)?.value ? "expired" : "none" };

  const admin = await db.from("admin_users").select("user_id").eq("user_id", data.user.id).maybeSingle();
  if (!admin.data) return { status: "none" };
  return { status: "ok", user: { id: data.user.id, email: data.user.email ?? "" } };
}

/** For server components: redirects to login (or a silent refresh) unless an admin is signed in. */
export async function requireAdmin(): Promise<AdminUser> {
  const s = await getAuthState();
  if (s.status === "ok") return s.user;
  if (s.status === "expired") redirect("/api/admin/refresh");
  redirect("/admin/login");
}

/** For route handlers: returns the admin or null (caller responds 401). */
export async function getAdminForApi(): Promise<AdminUser | null> {
  const s = await getAuthState();
  return s.status === "ok" ? s.user : null;
}
