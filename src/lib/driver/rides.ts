import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DRIVER_FLOW, canTransition, chatAllowedForStatus, isOpenForDriver, rideMayProgress, startRideWindow, leaveForPickupWindow, type BookingStatus } from "@/lib/booking-status";
import { loadBookingSettings } from "@/lib/policies";
import { driverDisplayName } from "@/lib/driver/profile";
import { driverRatingSummary } from "@/lib/ratings";

/**
 * What a driver may see about THEIR OWN assigned rides. Deliberately excludes pricing, payment state, tokens, internal notes
 * and the customer's email. Customer and passenger PHONE NUMBERS are never sent to drivers: they reach the customer through the
 * in-app chat and, if something urgent comes up, through the Vanta helpline.
 */
export interface DriverRide {
  id: string; reference: string; status: BookingStatus; pickupAt: string; pickup: string; dropoff: string | null; stops: string[];
  passengers: number; checkedBags: number | null; carryOnBags: number | null; assistanceNotes: string | null; pickupInstructions: string | null; notes: string | null;
  contactName: string | null; passengerName: string | null;
  open: boolean; awaitingPayment: boolean; nextStatuses: BookingStatus[];
  /** ISO time the Start Ride button unlocks (two hours before pickup), computed on the server. Null when the pickup time is invalid. */
  startOpensAt: string | null; chatOpen: boolean;
  /** ISO time Leave for Pickup unlocks (admin-configurable dispatch window before pickup). */
  leaveOpensAt: string | null;
  /** Completed rides only: whether this driver has already rated the customer. */
  customerRated: boolean;
}

/** The driver's own profile card. Rating and points are included ONLY when an admin has made them visible for this driver. */
export interface DriverProfileCard {
  displayName: string; fullName: string; vehicle: string | null; plate: string | null; location: string | null; preferredArea: string | null; imageUrl: string | null;
  rating: { avg: number | null; count: number } | null; points: number | null;
}

export async function loadDriverProfile(db: SupabaseClient, driverId: string): Promise<DriverProfileCard | null> {
  const { data: d } = await db.from("drivers").select("id,full_name,first_name,preferred_name,vehicle_description,vehicle_plate,location,preferred_area,image_url,performance_points,show_rating_to_driver,show_points_to_driver").eq("id", driverId).maybeSingle();
  if (!d) return null;
  return {
    displayName: driverDisplayName(d) ?? d.full_name, fullName: d.full_name, vehicle: d.vehicle_description ?? null, plate: d.vehicle_plate ?? null, location: d.location ?? null, preferredArea: d.preferred_area ?? null, imageUrl: d.image_url ?? null,
    rating: d.show_rating_to_driver === true ? await driverRatingSummary(db, driverId) : null,
    points: d.show_points_to_driver === true && d.performance_points != null ? Number(d.performance_points) : null,
  };
}

const COLS = "id,reference,status,pickup_at,pickup_address,dropoff_address,passengers,checked_bags,carry_on_bags,assistance_notes,pickup_instructions,notes,customer_id,driver_id,confirmed_at,payment_status";

export async function loadDriverRides(db: SupabaseClient, driverId: string): Promise<DriverRide[]> {
  const { data: rows, error } = await db.from("bookings").select(COLS).eq("driver_id", driverId).order("pickup_at", { ascending: true }).limit(300);
  if (error) { console.error("[driver] rides query failed", error.message); return []; }
  const list = (rows ?? []) as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!list.length) return [];
  const ids = list.map((r) => r.id as string);
  const custIds = [...new Set(list.map((r) => r.customer_id as string))];
  const settings = await loadBookingSettings(db);
  const done = list.filter((r) => r.status === "completed").map((r) => r.id as string);
  const rated = done.length ? await db.from("customer_ratings").select("booking_id").in("booking_id", done) : { data: [] as { booking_id: string }[] };
  const ratedSet = new Set((rated.data ?? []).map((r: { booking_id: string }) => r.booking_id));
  const [stops, people, custs] = await Promise.all([
    db.from("booking_stops").select("booking_id,position,address").in("booking_id", ids).order("position"),
    db.from("booking_people").select("booking_id,role,full_name").in("booking_id", ids).eq("role", "passenger"),
    db.from("customers").select("id,name").in("id", custIds),
  ]);
  return list.map((b) => {
    const status = b.status as BookingStatus;
    const open = isOpenForDriver(status);
    const mayProgress = rideMayProgress({ status, confirmed_at: b.confirmed_at ?? null, payment_status: b.payment_status ?? null });
    const cust = (custs.data ?? []).find((c: Record<string, any>) => c.id === b.customer_id); // eslint-disable-line @typescript-eslint/no-explicit-any
    const pax = (people.data ?? []).find((p: Record<string, any>) => p.booking_id === b.id); // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      id: b.id, reference: b.reference, status, pickupAt: b.pickup_at, pickup: b.pickup_address, dropoff: b.dropoff_address ?? null,
      stops: (stops.data ?? []).filter((s: Record<string, any>) => s.booking_id === b.id).map((s: Record<string, any>) => String(s.address)), // eslint-disable-line @typescript-eslint/no-explicit-any
      passengers: b.passengers, checkedBags: b.checked_bags ?? null, carryOnBags: b.carry_on_bags ?? null,
      // Instructions are only useful for a ride that is still to be done.
      assistanceNotes: open ? b.assistance_notes ?? null : null, pickupInstructions: open ? b.pickup_instructions ?? null : null, notes: open ? b.notes ?? null : null,
      contactName: open ? cust?.name ?? null : null,
      passengerName: open ? pax?.full_name ?? null : null,
      open, awaitingPayment: open && !mayProgress,
      nextStatuses: mayProgress ? DRIVER_FLOW.filter((to) => canTransition("driver", status, to)) : [],
      startOpensAt: startRideWindow(b.pickup_at, Date.now()).opensAt, chatOpen: chatAllowedForStatus(status),
      leaveOpensAt: leaveForPickupWindow(b.pickup_at, Date.now(), settings.dispatchWindowMinutes).opensAt, customerRated: ratedSet.has(b.id),
    } satisfies DriverRide;
  });
}
