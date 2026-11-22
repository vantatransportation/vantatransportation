import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";
import { revalidateSite } from "@/lib/admin/revalidate";
import { cloudName, releaseAsset } from "@/lib/cloudinary";
import { FAMILY_LABELS, familyKey, validateFamilyInput } from "@/lib/family-section";

export const runtime = "nodejs";

/** Saves the "Every Passenger Is Family." section: text, on/off switch and image. Same-origin, admin only, strictly validated. */
export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const { admin, db } = g;
  const body = await readJson(request);
  const v = validateFamilyInput(body?.content, cloudName());
  if (!v.ok) return json({ error: v.error }, 422);
  const d = v.data;

  const before = await db.from("site_content").select("value").eq("key", familyKey("image")).maybeSingle();
  const oldId = (before.data?.value as { publicId?: unknown } | null | undefined)?.publicId;

  const values: Record<string, unknown> = {
    enabled: d.enabled, title: d.title, subtitle: d.subtitle, body: d.body, closing: d.closing, image: d.image,
  };
  for (const [k, value] of Object.entries(values)) {
    const key = familyKey(k as keyof typeof FAMILY_LABELS);
    const upd = await db.from("site_content").update({ value: value as never, is_placeholder: false }).eq("key", key).select("key");
    if (upd.error) { console.error("[admin/family]", upd.error.message); return json({ error: "Could not save. Has migration 0011 been applied?" }, 500); }
    if (!upd.data?.length) {
      const ins = await db.from("site_content").insert({ key, label: FAMILY_LABELS[k as keyof typeof FAMILY_LABELS], group_name: "Home", value: value as never, is_placeholder: false });
      if (ins.error) { console.error("[admin/family]", ins.error.message); return json({ error: "Could not save." }, 500); }
    }
  }
  revalidateSite();
  await db.from("activity_logs").insert({ actor_id: admin.id, action: "family_section.update", entity_type: "site_content", meta: {} });
  if (typeof oldId === "string" && oldId && oldId !== d.image.publicId) await releaseAsset(db, oldId);
  return json({ ok: true });
}
