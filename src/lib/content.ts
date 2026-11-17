import { cache } from "react";
import { getPublicClient } from "@/lib/supabase/public";
import { defaultSiteData } from "@/data/defaults";
import type { SiteData, Service } from "@/lib/types";
import { hasRealPhoto } from "@/lib/vehicle-photo";

/**
 * Loads public site content from Supabase. Falls back to built-in defaults when
 * Supabase is not configured or a request fails, so the site never breaks.
 */
export const getSiteData = cache(async (): Promise<SiteData> => {
  const db = getPublicClient();
  if (!db) return defaultSiteData;

  try {
    const [cats, vehs, stds, faqs, content, promo] = await Promise.all([
      db.from("vehicle_categories").select("*").order("sort_order"),
      db.from("vehicles").select("*, vehicle_tiers(name), vehicle_categories(name, slug, capacity_label)").order("sort_order"),
      db.from("vehicle_standards").select("*").order("sort_order"),
      db.from("faqs").select("*").order("sort_order"),
      db.from("site_content").select("key, value"),
      db.from("promotions").select("*").order("created_at", { ascending: false }).limit(1),
    ]);
    if (cats.error || vehs.error || stds.error || faqs.error || content.error) {
      // Do not hide this: the built-in defaults have no photos, so a failed query makes edits look "not saved".
      console.error("[site] Supabase read failed; showing built-in defaults", { categories: cats.error?.message, vehicles: vehs.error?.message, standards: stds.error?.message, faqs: faqs.error?.message, content: content.error?.message });
      return defaultSiteData;
    }

    const contentMap: Record<string, unknown> = { ...defaultSiteData.content };
    for (const row of content.data ?? []) contentMap[row.key as string] = row.value;

    const p = promo.error ? null : (promo.data ?? [])[0];
    return {
      source: "supabase",
      promotion: p ? {
        id: p.id, title: p.title, description: p.description ?? "", imageUrl: p.image_url ?? "", ctaText: p.cta_text ?? "", ctaUrl: p.cta_url ?? "",
        frequency: p.display_frequency, showOnMobile: p.show_on_mobile, updatedAt: p.updated_at,
      } : null,
      categories: (cats.data ?? []).map((c) => ({
        id: c.id, name: c.name, slug: c.slug, description: c.description ?? "",
        capacityLabel: c.capacity_label ?? "", image: c.image_url || "/vehicles/sedan.svg",
      })),
      vehicles: (vehs.data ?? []).map((v) => ({
        id: v.id, name: v.name,
        categoryName: v.vehicle_categories?.name ?? "", categorySlug: v.vehicle_categories?.slug ?? "",
        tierName: v.vehicle_tiers?.name ?? "", similarModels: v.similar_models ?? "",
        description: v.description ?? "", passengers: v.passenger_capacity, luggage: v.luggage_capacity,
        image: hasRealPhoto(v.image_url) ? v.image_url : null, capacityLabel: v.vehicle_categories?.capacity_label ?? "", isAvailable: v.is_available,
      })),
      standards: (stds.data ?? []).map((s) => ({ id: s.id, title: s.title, description: s.description ?? "" })),
      faqs: (faqs.data ?? []).map((f) => ({ id: f.id, question: f.question, answer: f.answer })),
      content: contentMap,
    };
  } catch (e) {
    console.error("[site] Loading site data failed; showing built-in defaults", e);
    return defaultSiteData;
  }
});

export function text(content: Record<string, unknown>, key: string, fallback = ""): string {
  const v = content[key];
  return typeof v === "string" && v.trim() ? v : fallback;
}

export function services(content: Record<string, unknown>): Service[] {
  const v = content["services"];
  return Array.isArray(v) ? (v as Service[]).filter((s) => s && s.title) : [];
}

export function listOf(content: Record<string, unknown>, key: string): Service[] {
  const v = content[key];
  return Array.isArray(v) ? (v as Service[]).filter((s) => s && s.title) : [];
}
