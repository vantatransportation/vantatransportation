import { json } from "@/lib/http";
import { getAdminForApi } from "@/lib/admin/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authenticated feed for the admin dashboard: the latest alerts plus this admin's unread count.
 * Polled at a low frequency (and only while the tab is visible). Titles and bodies never contain
 * names, phone numbers, addresses or emergency-contact details.
 * GET is read-only, so no CSRF/origin check is needed; the admin session cookie is required.
 */
export async function GET() {
  const admin = await getAdminForApi();
  if (!admin) return json({ error: "Please sign in again." }, 401);
  const db = getAdminClient();
  if (!db) return json({ error: "Database is not configured." }, 503);
  const [list, reads] = await Promise.all([
    db.from("admin_notifications").select("id,event,title,body,link,created_at").order("created_at", { ascending: false }).limit(30),
    db.from("admin_notification_reads").select("notification_id").eq("user_id", admin.id).limit(500),
  ]);
  if (list.error) return json({ error: "Could not load notifications." }, 500);
  const read = new Set((reads.data ?? []).map((r: { notification_id: string }) => r.notification_id));
  const items = (list.data ?? []).map((n: Record<string, unknown>) => ({ ...n, read: read.has(String(n.id)) }));
  return json({ items, unread: items.filter((i: { read: boolean }) => !i.read).length });
}
