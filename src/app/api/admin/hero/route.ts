import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";
import { revalidateSite } from "@/lib/admin/revalidate";
import { cloudName, releaseAsset } from "@/lib/cloudinary";
import { MAX_HERO_SLIDES, validHeroRef, validateSettingsInput } from "@/lib/hero";
import { clean } from "@/lib/validation";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Admin API for the hero slideshow. Every action is same-origin, signed-in-admin only. Images must be in OUR Cloudinary account and
 * the hero folder (uploaded with a server-signed request); arbitrary URLs are rejected. Each write refreshes the public site.
 */
export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const { admin, db } = g;
  const body = await readJson(request);
  if (!body) return json({ error: "Invalid request." }, 400);
  const id = typeof body.id === "string" && UUID_RE.test(body.id) ? body.id : null;
  const log = (action: string, meta: Record<string, unknown> = {}) => db.from("activity_logs").insert({ actor_id: admin.id, action: `hero.${action}`, entity_type: "hero_slides", entity_id: id, meta });
  const done = (extra: Record<string, unknown> = {}) => { revalidateSite(); return json({ ok: true, ...extra }); };
  const fail = (e: { message?: string } | null, what: string) => { console.error(`[admin/hero] ${what}`, e?.message); return json({ error: `Could not save (${what}). Has migration 0011 been applied?` }, 500); };

  switch (body.action) {
    case "save_settings": {
      const v = validateSettingsInput(body.settings);
      if (!v.ok) return json({ error: v.error }, 422);
      const existing = await db.from("hero_settings").select("id").limit(1).maybeSingle();
      if (existing.error) return fail(existing.error, "settings");
      const res = existing.data ? await db.from("hero_settings").update(v.data).eq("id", true) : await db.from("hero_settings").insert({ id: true, ...v.data });
      if (res.error) return fail(res.error, "settings");
      await log("settings", v.data);
      return done();
    }

    case "add_slide": {
      if (!validHeroRef(body.url, body.publicId, cloudName())) return json({ error: "The image must be uploaded with the hero uploader (Cloudinary, hero folder)." }, 422);
      const list = await db.from("hero_slides").select("id,sort_order").order("sort_order");
      if (list.error) return fail(list.error, "slides");
      const rows = (list.data ?? []) as { id: string; sort_order: number }[];
      if (rows.length >= MAX_HERO_SLIDES) return json({ error: `You can have at most ${MAX_HERO_SLIDES} slides. Remove one first.` }, 422);
      const next = rows.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0) + 1;
      const ins = await db.from("hero_slides").insert({ image_url: body.url, image_public_id: body.publicId, alt_text: clean(body.alt, 200) || null, sort_order: next, is_active: true }).select("id").single();
      if (ins.error) return fail(ins.error, "slides");
      await db.from("activity_logs").insert({ actor_id: admin.id, action: "hero.slide_added", entity_type: "hero_slides", entity_id: ins.data.id, meta: {} });
      return done({ id: ins.data.id });
    }

    case "replace_slide": {
      if (!id) return json({ error: "Missing slide." }, 400);
      if (!validHeroRef(body.url, body.publicId, cloudName())) return json({ error: "The image must be uploaded with the hero uploader (Cloudinary, hero folder)." }, 422);
      const before = await db.from("hero_slides").select("id,image_public_id").eq("id", id).maybeSingle();
      if (!before.data) return json({ error: "Slide not found." }, 404);
      const patch: Record<string, unknown> = { image_url: body.url, image_public_id: body.publicId };
      if (typeof body.alt === "string") patch.alt_text = clean(body.alt, 200) || null;
      const upd = await db.from("hero_slides").update(patch).eq("id", id).select("id");
      if (upd.error || !upd.data?.length) return fail(upd.error, "slides");
      await log("slide_replaced");
      if (before.data.image_public_id && before.data.image_public_id !== body.publicId) await releaseAsset(db, before.data.image_public_id as string);
      return done();
    }

    case "update_slide": {
      if (!id) return json({ error: "Missing slide." }, 400);
      const patch: Record<string, unknown> = {};
      if (typeof body.isActive === "boolean") patch.is_active = body.isActive;
      if (typeof body.alt === "string") patch.alt_text = clean(body.alt, 200) || null;
      if (!Object.keys(patch).length) return json({ error: "Nothing to change." }, 400);
      const upd = await db.from("hero_slides").update(patch).eq("id", id).select("id");
      if (upd.error) return fail(upd.error, "slides");
      if (!upd.data?.length) return json({ error: "Slide not found." }, 404);
      await log("slide_updated", patch);
      return done();
    }

    case "remove_slide": {
      if (!id) return json({ error: "Missing slide." }, 400);
      const before = await db.from("hero_slides").select("id,image_public_id").eq("id", id).maybeSingle();
      if (!before.data) return json({ error: "Slide not found." }, 404);
      const del = await db.from("hero_slides").delete().eq("id", id);
      if (del.error) return fail(del.error, "slides");
      await log("slide_removed");
      if (before.data.image_public_id) await releaseAsset(db, before.data.image_public_id as string); // deleted only if nothing else uses it
      return done();
    }

    case "reorder": {
      const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)) : [];
      const list = await db.from("hero_slides").select("id");
      if (list.error) return fail(list.error, "slides");
      const current = ((list.data ?? []) as { id: string }[]).map((r) => r.id);
      if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((x) => current.includes(x))) return json({ error: "The slide list changed. Reload the page and try again." }, 409);
      const results = await Promise.all(ids.map((sid, i) => db.from("hero_slides").update({ sort_order: i + 1 }).eq("id", sid)));
      const bad = results.find((r) => r.error);
      if (bad?.error) return fail(bad.error, "order");
      await log("reordered", { count: ids.length });
      return done();
    }

    default:
      return json({ error: "Unknown action." }, 400);
  }
}
