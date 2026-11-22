import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";
import { revalidateSite } from "@/lib/admin/revalidate";
import { FAMILY_PREFIX } from "@/lib/family-section";

export const runtime = "nodejs";

/** Updates one website-content value, preserving its type (text, list or switch). */
export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const body = await readJson(request);
  const key = typeof body?.key === "string" ? body.key : "";
  // The family section has its own validated editor (image upload, length limits); the generic editor must not bypass it.
  if (key.startsWith(FAMILY_PREFIX)) return json({ error: "Edit this section under Admin, Family section." }, 422);
  const text = typeof body?.value === "string" ? body.value.slice(0, 20000) : "";
  const { data: row } = await g.db.from("site_content").select("key,value").eq("key", key).maybeSingle();
  if (!row) return json({ error: "Unknown content item." }, 404);

  let value: unknown = text;
  if (typeof row.value !== "string") {
    try {
      value = JSON.parse(text);
    } catch {
      return json({ error: "This item must be valid JSON (for example true/false, or a list in [ ] brackets)." }, 422);
    }
    if (typeof value !== typeof row.value || Array.isArray(value) !== Array.isArray(row.value)) {
      return json({ error: "The value must keep the same kind as before." }, 422);
    }
  }
  const upd = await g.db.from("site_content").update({ value: value as never, is_placeholder: false }).eq("key", key).select("key");
  if (upd.error || !upd.data?.length) { console.error("[admin/content]", upd.error); return json({ error: "Could not save." }, 500); }
  revalidateSite();
  await g.db.from("activity_logs").insert({ actor_id: g.admin.id, action: "content.update", entity_type: "site_content", meta: { key } });
  return json({ ok: true });
}
