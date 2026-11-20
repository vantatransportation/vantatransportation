import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DRIVER_FLOW, canTransition, isOpenForDriver, type BookingStatus } from "@/lib/booking-status";

/**
 * What a driver may see about THEIR OWN assigned rides. Deliberately excludes pricing, payment state, tokens, internal notes
 * and the customer's email. Contact phone numbers are included only while the ride is still open.
 */
export interface DriverRide {
  id: string; reference: string; status: BookingStatus; pickupAt: string; pickup: string; dropoff: string | null; stops: string[];
  passengers: number; checkedBags: number | null; carryOnBags: number | null; assistanceNotes: string | null; pickupInstructions: string | null; notes: string | null;
  contactName: string | null; contactPhone: string | null; passengerName: string | null; passengerPhone: string | null;
  open: boolean; nextStatuses: BookingStatus[];
}

const COLS = "id,reference,status,pickup_at,pickup_address,dropoff_address,passengers,checked_bags,carry_on_bags,assistance_notes,pickup_instructions,notes,customer_id,driver_id";

export async function loadDriverRides(db: SupabaseClient, driverId: string): Promise<DriverRide[]> {
  const { data: rows, error } = await db.from("bookings").select(COLS).eq("driver_id", driverId).order("pickup_at", { ascending: true }).limit(300);
  if (error) { console.error("[driver] rides query failed", error.message); return []; }
  const list = (rows ?? []) as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!list.length) return [];
  const ids = list.map((r) => r.id as string);
  const custIds = [...new Set(list.map((r) => r.customer_id as string))];
  const [stops, people, custs] = await Promise.all([
    db.from("booking_stops").select("booking_id,position,address").in("booking_id", ids).order("position"),
    db.from("booking_people").select("booking_id,role,full_name,phone").in("booking_id", ids).eq("role", "passenger"),
    db.from("customers").select("id,name,phone").in("id", custIds),
  ]);
  return list.map((b) => {
    const status = b.status as BookingStatus;
    const open = isOpenForDriver(status);
    const cust = (custs.data ?? []).find((c: Record<string, any>) => c.id === b.customer_id); // eslint-disable-line @typescript-eslint/no-explicit-any
    const pax = (people.data ?? []).find((p: Record<string, any>) => p.booking_id === b.id); // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      id: b.id, reference: b.reference, status, pickupAt: b.pickup_at, pickup: b.pickup_address, dropoff: b.dropoff_address ?? null,
      stops: (stops.data ?? []).filter((s: Record<string, any>) => s.booking_id === b.id).map((s: Record<string, any>) => String(s.address)), // eslint-disable-line @typescript-eslint/no-explicit-any
      passengers: b.passengers, checkedBags: b.checked_bags ?? null, carryOnBags: b.carry_on_bags ?? null,
      // Instructions are only useful for a ride that is still to be done.
      assistanceNotes: open ? b.assistance_notes ?? null : null, pickupInstructions: open ? b.pickup_instructions ?? null : null, notes: open ? b.notes ?? null : null,
      contactName: open ? cust?.name ?? null : null, contactPhone: open ? cust?.phone ?? null : null,
      passengerName: open ? pax?.full_name ?? null : null, passengerPhone: open ? pax?.phone ?? null : null,
      open, nextStatuses: DRIVER_FLOW.filter((to) => canTransition("driver", status, to)),
    } satisfies DriverRide;
  });
}
