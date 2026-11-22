import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "@/lib/supabase/admin";
import { getPublicClient } from "@/lib/supabase/public";
import { buildHeroView, normalizeSettings, type HeroSlideRow, type HeroView } from "@/lib/hero";

export const HERO_SLIDE_COLUMNS = "id,image_url,image_public_id,alt_text,sort_order,is_active,created_at";

/** Reads settings and active slides with one client. Throws on a database error (for example the migration is not applied yet). */
export async function readHero(db: SupabaseClient): Promise<HeroView | null> {
  const [settings, slides] = await Promise.all([
    db.from("hero_settings").select("*").limit(1).maybeSingle(),
    db.from("hero_slides").select(HERO_SLIDE_COLUMNS).eq("is_active", true).order("sort_order").order("created_at"),
  ]);
  if (settings.error) throw settings.error;
  if (slides.error) throw slides.error;
  return buildHeroView(normalizeSettings(settings.data as Record<string, unknown> | null), (slides.data ?? []) as HeroSlideRow[]);
}

/**
 * The public hero slideshow, or null when there is nothing to show. Null (the original gradient hero) is also the result when
 * the tables do not exist yet or cannot be read: the home page must never fail because of the slideshow.
 */
export async function loadHeroView(): Promise<HeroView | null> {
  for (const db of [getAdminClient(), getPublicClient()] as (SupabaseClient | null)[]) {
    if (!db) continue;
    try {
      return await readHero(db);
    } catch (e) {
      console.warn("[hero] slideshow could not be read; showing the default hero", e instanceof Error ? e.message : (e as { message?: string })?.message ?? e);
    }
  }
  return null;
}
