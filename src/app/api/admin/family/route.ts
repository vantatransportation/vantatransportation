import { isDeepStrictEqual } from "node:util";
import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";
import { revalidateSite } from "@/lib/admin/revalidate";
import { cloudName, releaseAsset } from "@/lib/cloudinary";
import { FAMILY_LABELS, buildFamilyInput, familyKey, validateFamilyInput } from "@/lib/family-section";

export const runtime = "nodejs";

/**
 * Saves the "Every Passenger Is Family." section: text, on/off switch and image. Same-origin, admin only, strictly validated.
 *
 * All six rows are written in ONE upsert (one statement, so a failure never leaves the text saved and the image not, or the
 * reverse), every row is written with group_name "Home" (rows in the "Settings" group are hidden from the public site by RLS, and
 * the old update-only path never corrected that), and success is only reported after the database has returned the stored rows
 * and they match what was sent.
 */
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

  const values: Record<keyof typeof FAMILY_LABELS, unknown> = {
    enabled: d.enabled, title: d.title, subtitle: d.subtitle, body: d.body, closing: d.closing, image: d.image,
  };
  const rows = (Object.keys(values) as (keyof typeof FAMILY_LABELS)[]).map((k) => ({
    key: familyKey(k), label: FAMILY_LABELS[k], group_name: "Home", value: values[k] as never, is_placeholder: false,
  }));

  const saved = await db.from("site_content").upsert(rows, { onConflict: "key" }).select("key,value,group_name");
  if (saved.error) {
    console.error("[admin/family] save failed", saved.error.code, saved.error.message);
    return json({ error: "Could not save the Family section. Nothing was changed." }, 500);
  }
  const stored = new Map<string, unknown>((saved.data ?? []).map((r: { key: string; value: unknown }): [string, unknown] => [r.key, r.value]));
  const mismatch = rows.filter((r) => !isDeepStrictEqual(stored.get(r.key), r.value)).map((r) => r.key);
  if (mismatch.length) {
    // Never report success for a write the database did not store as sent.
    console.error("[admin/family] database did not return the saved values for", mismatch.join(", "));
    return json({ error: "The database did not confirm the save. Please try again." }, 500);
  }

  const revalidated = revalidateSite();
  const log = await db.from("activity_logs").insert({ actor_id: admin.id, action: "family_section.update", entity_type: "site_content", meta: {} });
  if (log.error) console.error("[admin/family] activity log failed", log.error.message);
  if (typeof oldId === "string" && oldId && oldId !== d.image.publicId) await releaseAsset(db, oldId);
  // `content` is what the database now holds, so the form shows the stored values rather than what was typed.
  return json({ ok: true, revalidated, content: buildFamilyInput(Object.fromEntries(stored)) });
}
