import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { STATUS_LABEL, isOpenForDriver, type BookingStatus } from "@/lib/booking-status";
import { UUID_RE, chatOpen } from "@/lib/chat-server";

/**
 * What a customer may see on their private booking page. The unguessable booking token is the credential, so everything
 * returned here is about that one booking only. Never includes internal notes, other bookings or the driver's email.
 */
export interface TripView {
  reference: string; status: BookingStatus; statusLabel: string; pickupAt: string; pickup: string; dropoff: string | null; stops: string[];
  passengers: number; checkedBags: number | null; carryOnBags: number | null;
  driver: { name: string; phone: string | null; plate: string | null; vehicle: string | null } | null;
  charges: { fixedPriceCents: number; rushCents: number; tipCents: number; meetGreetCents: number; seatCents: number; totalCents: number; currency: string } | null;
  paymentStatus: string; payable: boolean; chatOpen: boolean; chatAvailable: boolean; terminalNote: string | null;
}

const COLS = "id,reference,status,pickup_at,pickup_address,dropoff_address,passengers,checked_bags,carry_on_bags,driver_id,payment_status,payment_released_at,online_amount_cents,fixed_price_cents,rush_surcharge_cents,tip_cents,meet_greet_selected,meet_greet_fee_cents,child_seat_fee_cents,currency,rejection_reason,cancellation_reason";

export async function loadTrip(db: SupabaseClient, token: unknown): Promise<{ id: string; view: TripView; driverId: string | null } | null> {
  if (typeof token !== "string" || !UUID_RE.test(token)) return null;
  const { data: b } = await db.from("bookings").select(COLS).eq("payment_token", token).maybeSingle();
  if (!b) return null;
  const status = b.status as BookingStatus;
  const open = isOpenForDriver(status);
  let driver: TripView["driver"] = null;
  // The driver's contact details are shown only once a driver is actually assigned and the ride is still open.
  if (b.driver_id && open) {
    const { data: d } = await db.from("drivers").select("full_name,phone,vehicle_plate,vehicle_description").eq("id", b.driver_id).maybeSingle();
    if (d) driver = { name: d.full_name, phone: d.phone ?? null, plate: d.vehicle_plate ?? null, vehicle: d.vehicle_description ?? null };
  }
  const stops = await db.from("booking_stops").select("position,address").eq("booking_id", b.id).order("position");
  const released = Boolean(b.payment_released_at && b.driver_id);
  const settled = ["paid", "refunded", "partially_refunded"].includes(String(b.payment_status));
  const hasAmount = b.online_amount_cents != null && b.fixed_price_cents != null;
  return {
    id: b.id, driverId: b.driver_id ?? null,
    view: {
      reference: b.reference, status, statusLabel: STATUS_LABEL[status] ?? status, pickupAt: b.pickup_at, pickup: b.pickup_address, dropoff: b.dropoff_address ?? null,
      stops: (stops.data ?? []).map((s: Record<string, unknown>) => String(s.address)),
      passengers: b.passengers, checkedBags: b.checked_bags ?? null, carryOnBags: b.carry_on_bags ?? null, driver,
      charges: hasAmount ? { fixedPriceCents: b.fixed_price_cents, rushCents: b.rush_surcharge_cents ?? 0, tipCents: b.tip_cents ?? 0, meetGreetCents: b.meet_greet_selected ? b.meet_greet_fee_cents ?? 0 : 0, seatCents: b.child_seat_fee_cents ?? 0, totalCents: b.online_amount_cents, currency: b.currency ?? "USD" } : null,
      paymentStatus: String(b.payment_status), payable: released && open && hasAmount && !settled,
      chatOpen: chatOpen(b), chatAvailable: Boolean(b.driver_id),
      terminalNote: status === "rejected" ? (b.rejection_reason ?? "We were unable to accept this request.") : status === "cancelled" ? (b.cancellation_reason ?? "This booking was cancelled.") : null,
    },
  };
}
