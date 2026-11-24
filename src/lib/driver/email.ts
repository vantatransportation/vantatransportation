import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driverDisplayName } from "@/lib/driver/profile";

/**
 * The driver details a customer email may carry, read from the REAL saved driver record (never placeholders). Includes the preferred
 * or first name, the car and the license plate. The driver's phone number and surname are never included. Returns undefined fields when
 * a value is not saved, so a missing detail is simply left out rather than invented.
 */
export async function driverEmailFields(db: SupabaseClient, driverId: string | null | undefined): Promise<Record<string, string | undefined>> {
  if (!driverId) return {};
  const { data: d } = await db.from("drivers").select("full_name,first_name,preferred_name,vehicle_description,vehicle_plate").eq("id", driverId).maybeSingle();
  if (!d) return {};
  return { Driver: driverDisplayName(d) ?? undefined, "Driver vehicle": d.vehicle_description || undefined, "License plate": d.vehicle_plate || undefined };
}
