import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client. Bypasses RLS, so it must only be used in server code
 * (API routes, server actions) AFTER the request has been validated/authorized.
 * Never import this from a client component.
 */
/**
 * Detects the classic misconfiguration of putting the anon/publishable key in SUPABASE_SERVICE_ROLE_KEY.
 * With that key every admin_users read is filtered by RLS and returns nothing, so real admins look unauthorized.
 * Only inspects the key's shape (JWT "role" claim or sb_ prefix); the value is never logged or returned.
 */
export function serviceKeyProblem(): string | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (key.startsWith("sb_publishable_")) return "SUPABASE_SERVICE_ROLE_KEY contains a publishable (anon) key. Use the service_role / secret key from Supabase, Project Settings, API.";
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      const role = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.role;
      if (role && role !== "service_role") return `SUPABASE_SERVICE_ROLE_KEY contains a "${role}" key. Use the service_role key from Supabase, Project Settings, API.`;
    } catch {
      /* not a decodable JWT: leave it to Supabase to reject */
    }
  }
  return null;
}

export function getAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
