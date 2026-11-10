import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";

export const runtime = "nodejs";

/** Marks one alert (or all) as read for the signed-in admin only. */
export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const body = await readJson(request);
  const ids: string[] = [];
  if (body?.all === true) {
    const { data } = await g.db.from("admin_notifications").select("id").order("created_at", { ascending: false }).limit(100);
    ids.push(...(data ?? []).map((r: { id: string }) => r.id));
  } else if (typeof body?.id === "string") ids.push(body.id);
  if (!ids.length) return json({ ok: true });
  const up = await g.db.from("admin_notification_reads").upsert(ids.map((nid) => ({ notification_id: nid, user_id: g.admin.id })), { onConflict: "notification_id,user_id", ignoreDuplicates: true });
  if (up.error) return json({ error: "Could not update." }, 500);
  return json({ ok: true });
}
