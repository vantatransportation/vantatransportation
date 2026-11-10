import "server-only";
import { json, sameOrigin } from "@/lib/http";
import { getAdminForApi, type AdminUser } from "./auth";
import { getAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Common gate for admin mutation routes: same-origin, authenticated admin, database configured. */
export async function guard(request: Request): Promise<{ admin: AdminUser; db: SupabaseClient } | Response> {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  const admin = await getAdminForApi();
  if (!admin) return json({ error: "Please sign in again." }, 401);
  const db = getAdminClient();
  if (!db) return json({ error: "Database is not configured." }, 503);
  return { admin, db };
}
