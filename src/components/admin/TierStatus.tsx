import type { SupabaseClient } from "@supabase/supabase-js";

/** Setup warnings for the tier pricing page: missing fixed prices and tiers with no vehicles. Server component. */
export default async function TierStatus({ rows, db }: { rows: Record<string, unknown>[]; db: SupabaseClient }) {
  const { data: vehicles } = await db.from("vehicles").select("tier_id");
  const counts = new Map<string, number>();
  for (const v of (vehicles ?? []) as { tier_id: string | null }[]) if (v.tier_id) counts.set(v.tier_id, (counts.get(v.tier_id) ?? 0) + 1);
  const missing = rows.filter((r) => r.is_active !== false && r.fixed_price_cents == null).map((r) => String(r.name));
  const empty = rows.filter((r) => r.is_active !== false && !counts.get(String(r.id))).map((r) => String(r.name));
  return (
    <div role="status">
      {missing.length > 0 && <div className="notice notice--error"><strong>Setup needed.</strong> No fixed price is set for: {missing.join(", ")}. Customers cannot pay online for a vehicle in a tier until its fixed price is entered below. Bookings can still be requested.</div>}
      {empty.length > 0 && <div className="notice">No vehicles are assigned to: {empty.join(", ")}. Assign vehicles under Vehicles (the Tier field); customers choose a tier by choosing a vehicle.</div>}
    </div>
  );
}
