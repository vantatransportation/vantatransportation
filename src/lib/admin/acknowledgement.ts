import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PAID_STATES } from "@/lib/booking-status";

export interface UnacknowledgedRide { id: string; reference: string; pickupAt: string; driverName: string; driverPhone: string | null; driverEmail: string | null; hoursAway: number }

/**
 * Confirmed and paid rides with an assigned driver who has NOT yet tapped Getting Ready (the booking is still in assigned/confirmed).
 * Ordered by pickup time, earliest first, so an administrator can follow up with the right driver first. Read-only; admin pages only.
 */
export async function loadUnacknowledgedRides(db: SupabaseClient, nowMs: number = Date.now(), limit = 25): Promise<UnacknowledgedRide[]> {
  const { data } = await db.from("bookings")
    .select("id,reference,pickup_at,status,driver_id,confirmed_at,payment_status,drivers(full_name,phone,email)")
    .in("status", ["assigned", "confirmed"]).not("driver_id", "is", null).not("confirmed_at", "is", null).in("payment_status", PAID_STATES)
    .gte("pickup_at", new Date(nowMs).toISOString()).order("pickup_at", { ascending: true }).limit(limit);
  return ((data ?? []) as Record<string, any>[]).map((b) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const d = Array.isArray(b.drivers) ? b.drivers[0] : b.drivers;
    return { id: b.id, reference: b.reference, pickupAt: b.pickup_at, driverName: d?.full_name ?? "Driver", driverPhone: d?.phone ?? null, driverEmail: d?.email ?? null, hoursAway: Math.max(0, Math.round(((new Date(b.pickup_at).getTime() - nowMs) / 3600_000) * 10) / 10) };
  });
}
