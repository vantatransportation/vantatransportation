/**
 * Pure helpers that turn vehicle / category rows from Supabase into the shapes the PUBLIC site renders.
 * No server-only imports, so they are shared by the loader (content.ts) and the tests.
 *
 * Visibility rules (unchanged, only made explicit):
 *  - is_active    = "Shown on website". Only active vehicles and categories are listed on the home page and /rides.
 *  - is_available = "Available to book". It does NOT hide a vehicle from the public cards (they show a
 *                   "Currently unavailable" badge). Only the Calculate Your Fare list requires it (lib/fare/service.ts).
 */
import type { Category, Vehicle } from "@/lib/types";
import { resolvePhotoSrc, hasRealPhoto } from "@/lib/vehicle-photo";

/** Explicit column lists: the service-role client must never be used with select("*") for public output. */
export const FLEET_VEHICLE_SELECT =
  "id,name,similar_models,description,passenger_capacity,luggage_capacity,image_url,is_active,is_available,sort_order,vehicle_tiers(name,is_active),vehicle_categories(name,slug,capacity_label,is_active)";
export const FLEET_CATEGORY_SELECT = "id,name,slug,description,capacity_label,image_url,is_active,sort_order";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Category illustration used when a category has none of its own (a local SVG in /public, never a vehicle photo). */
export const DEFAULT_CATEGORY_IMAGE = "/vehicles/sedan.svg";

export function mapCategoryRows(rows: Row[] | null | undefined): Category[] {
  return (rows ?? []).filter((c) => c.is_active !== false).map((c) => ({
    id: c.id, name: c.name, slug: c.slug, description: c.description ?? "",
    capacityLabel: c.capacity_label ?? "", image: c.image_url || DEFAULT_CATEGORY_IMAGE,
  }));
}

/**
 * Maps vehicle rows. Rows that are not active are dropped (needed because the service-role client bypasses the
 * "public read active vehicles" RLS policy). A tier or category that is itself inactive is treated as absent, which is
 * exactly what the RLS policies do for the anonymous client's embedded rows.
 */
export function mapVehicleRows(rows: Row[] | null | undefined): Vehicle[] {
  return (rows ?? []).filter((v) => v.is_active !== false).map((v) => {
    const cat = v.vehicle_categories && v.vehicle_categories.is_active !== false ? v.vehicle_categories : null;
    const tier = v.vehicle_tiers && v.vehicle_tiers.is_active !== false ? v.vehicle_tiers : null;
    return {
      id: v.id, name: v.name,
      categoryName: cat?.name ?? "", categorySlug: cat?.slug ?? "",
      tierName: tier?.name ?? "", similarModels: v.similar_models ?? "",
      description: v.description ?? "", passengers: v.passenger_capacity, luggage: v.luggage_capacity ?? null,
      image: resolvePhotoSrc(v.image_url), capacityLabel: cat?.capacity_label ?? "", isAvailable: v.is_available !== false,
    };
  });
}

/**
 * The vehicle whose real photo represents a category tile: bookable vehicles first, then any vehicle with a photo.
 * Returns null when the category has no real photo, so the tile keeps its SVG illustration.
 */
export function pickCategoryVehicle(vehicles: Vehicle[], categorySlug: string): Vehicle | null {
  const inCategory = vehicles.filter((v) => v.categorySlug === categorySlug && hasRealPhoto(v.image));
  return inCategory.find((v) => v.isAvailable) ?? inCategory[0] ?? null;
}

/** One-line, secret-free summary for the host's logs. */
export function describeFleet(vehicles: Vehicle[]): string {
  const withPhoto = vehicles.filter((v) => hasRealPhoto(v.image)).length;
  return `${vehicles.length} vehicle(s), ${withPhoto} with a real photo`;
}
