import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPublicClient } from "@/lib/supabase/public";
import { getAdminClient } from "@/lib/supabase/admin";
import { defaultSiteData } from "@/data/defaults";
import type { Category, SiteData, Service, Vehicle } from "@/lib/types";
import { describePhotoProblem } from "@/lib/vehicle-photo";
import { loadVehicleTiers } from "@/lib/vehicle-tiers";
import { FLEET_CATEGORY_SELECT, FLEET_VEHICLE_SELECT, describeFleet, mapCategoryRows, mapVehicleRows } from "@/lib/fleet-data";

/**
 * Categories and vehicles for the public cards (home "Our Fleet", category tiles, /rides).
 *
 * Why this is separate from the other site content: the Calculate Your Fare list reads vehicles on the server with the
 * service-role client, while these cards used to read them with the anonymous key, in the same request as FAQs, standards
 * and site content. If anything in that one batch failed (missing/invalid anon key, an RLS or embed problem, a failing
 * unrelated table) EVERYTHING silently became the built-in defaults, whose vehicles have no photos, so every card showed
 * "Photo coming soon" while the calculator, which never touches that path, still showed the photos.
 *
 * Now: the server-side client is tried first (same access as the calculator; it bypasses RLS, so the same visibility rules
 * are applied explicitly in the query and in mapVehicleRows), then the anonymous client (RLS enforces the rules).
 * Returns null only when neither can read, and says why in the server log.
 */
export async function loadFleetData(): Promise<{ categories: Category[]; vehicles: Vehicle[]; via: "service" | "public" } | null> {
  const attempts: { via: "service" | "public"; db: SupabaseClient | null }[] = [
    { via: "service", db: getAdminClient() },
    { via: "public", db: getPublicClient() },
  ];
  for (const { via, db } of attempts) {
    if (!db) continue;
    try {
      const [cats, vehs] = await Promise.all([
        db.from("vehicle_categories").select(FLEET_CATEGORY_SELECT).eq("is_active", true).order("sort_order"),
        db.from("vehicles").select(FLEET_VEHICLE_SELECT).eq("is_active", true).order("sort_order"),
      ]);
      if (cats.error || vehs.error) {
        console.error(`[site] fleet read failed via ${via} client`, { categories: cats.error?.message, vehicles: vehs.error?.message });
        continue;
      }
      // Tiers come from the join table (never embedded in the vehicles query). Failures fall back to each vehicle's legacy tier.
      const { byVehicle } = await loadVehicleTiers(db, (vehs.data ?? []) as { id: string; tier_id?: string | null }[]);
      const vehicles = mapVehicleRows(vehs.data, byVehicle);
      // Diagnostics (no secrets): vehicles whose stored image value is unusable, and why.
      const problems = (vehs.data ?? []).map((v) => ({ name: v.name as string, why: describePhotoProblem(v.image_url) })).filter((x) => x.why);
      if (problems.length) console.warn("[site] vehicles with an unusable photo value", problems);
      console.info(`[site] fleet loaded via ${via} client: ${describeFleet(vehicles)}`);
      return { categories: mapCategoryRows(cats.data), vehicles, via };
    } catch (e) {
      console.error(`[site] fleet read threw via ${via} client`, e);
    }
  }
  console.error("[site] fleet could not be read with any Supabase client (check NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY); showing built-in defaults, which have no photos");
  return null;
}

/**
 * Loads public site content from Supabase. Falls back to built-in defaults when
 * Supabase is not configured or a request fails, so the site never breaks.
 */
export const getSiteData = cache(async (): Promise<SiteData> => {
  const fleet = await loadFleetData();
  const withFleet = (base: SiteData): SiteData => (fleet ? { ...base, categories: fleet.categories, vehicles: fleet.vehicles } : base);

  const db = getPublicClient();
  if (!db) {
    console.error("[site] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing; website text, FAQs and standards use built-in defaults");
    return withFleet(defaultSiteData);
  }

  try {
    const [stds, faqs, content, promo] = await Promise.all([
      db.from("vehicle_standards").select("*").order("sort_order"),
      db.from("faqs").select("*").order("sort_order"),
      db.from("site_content").select("key, value"),
      db.from("promotions").select("*").order("created_at", { ascending: false }).limit(1),
    ]);
    if (stds.error || faqs.error || content.error) {
      // Do not hide this: a failed query makes edits look "not saved". Vehicle photos no longer depend on it (see loadFleetData).
      console.error("[site] Supabase read failed; showing built-in website text", { standards: stds.error?.message, faqs: faqs.error?.message, content: content.error?.message });
      return withFleet(defaultSiteData);
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
      categories: fleet ? fleet.categories : defaultSiteData.categories,
      vehicles: fleet ? fleet.vehicles : defaultSiteData.vehicles,
      standards: (stds.data ?? []).map((s) => ({ id: s.id, title: s.title, description: s.description ?? "" })),
      faqs: (faqs.data ?? []).map((f) => ({ id: f.id, question: f.question, answer: f.answer })),
      content: contentMap,
    };
  } catch (e) {
    console.error("[site] Loading site data failed; showing built-in website text", e);
    return withFleet(defaultSiteData);
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
