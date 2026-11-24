/**
 * Booking lifecycle. Pure. One definition used by admin, driver and customer views.
 *
 *  new_request -> (admin approves + assigns driver) -> assigned -> getting_ready -> on_the_way -> arrived -> picked_up -> completed
 *  Legacy statuses (pending_confirmation, confirmed, in_progress, no_show) stay valid for existing rows.
 */
export const STATUSES = ["new_request", "pending_confirmation", "confirmed", "assigned", "getting_ready", "on_the_way", "arrived", "picked_up", "in_progress", "completed", "cancelled", "rejected", "no_show"] as const;
export type BookingStatus = (typeof STATUSES)[number];
export type Actor = "admin" | "driver" | "customer";

/** Driver-visible progress steps in order. */
export const DRIVER_FLOW: BookingStatus[] = ["assigned", "getting_ready", "on_the_way", "arrived", "picked_up", "completed"];

export const STATUS_LABEL: Record<BookingStatus, string> = {
  new_request: "Awaiting review", pending_confirmation: "Awaiting review", confirmed: "Confirmed", assigned: "Driver assigned", getting_ready: "Driver getting ready",
  on_the_way: "Driver on the way", arrived: "Driver arrived", picked_up: "Passenger picked up", in_progress: "In progress", completed: "Completed",
  cancelled: "Cancelled", rejected: "Declined", no_show: "No show",
};

export const AWAITING_REVIEW: BookingStatus[] = ["new_request", "pending_confirmation"];
const LEGACY_ACTIVE: BookingStatus[] = ["confirmed", "assigned", "in_progress"];

const DRIVER_NEXT: Partial<Record<BookingStatus, BookingStatus[]>> = {
  assigned: ["getting_ready", "on_the_way"],
  confirmed: ["getting_ready", "on_the_way"],
  getting_ready: ["on_the_way"],
  on_the_way: ["arrived"],
  arrived: ["picked_up"], // a no-show has policy and charge consequences: only an admin can record it
  picked_up: ["completed"],
  in_progress: ["completed"],
};

/** Transitions an admin may make (excluding approval/assignment, which have their own checked operations). */
const ADMIN_NEXT: Partial<Record<BookingStatus, BookingStatus[]>> = {
  new_request: ["rejected", "cancelled"], pending_confirmation: ["rejected", "cancelled"],
  confirmed: ["cancelled", "no_show"], assigned: ["cancelled", "no_show"],
  getting_ready: ["cancelled"], on_the_way: ["cancelled"], arrived: ["cancelled", "no_show"], picked_up: ["cancelled"], in_progress: ["cancelled", "completed"],
};

export function canTransition(actor: Actor, from: BookingStatus, to: BookingStatus): boolean {
  if (from === to) return false;
  if (actor === "driver") return (DRIVER_NEXT[from] ?? []).includes(to);
  if (actor === "admin") return (ADMIN_NEXT[from] ?? []).includes(to) || (DRIVER_NEXT[from] ?? []).includes(to);
  return false; // customers cannot move a booking through the workflow
}

export const canApprove = (s: BookingStatus) => AWAITING_REVIEW.includes(s);
/** Reassignment is allowed only before the passenger is on board. */
export const canAssign = (s: BookingStatus) => [...AWAITING_REVIEW, "confirmed", "assigned", "getting_ready"].includes(s);
export const isOpenForDriver = (s: BookingStatus) => [...LEGACY_ACTIVE, "getting_ready", "on_the_way", "arrived", "picked_up"].includes(s);
export const isTerminal = (s: BookingStatus) => ["completed", "cancelled", "rejected", "no_show"].includes(s);

/** Payment states that prove money was verifiably received (set only by the provider-verified payment path). */
export const PAID_STATES = ["paid", "deposit_paid", "partially_refunded"];

/**
 * The ONE rule for moving a ride forward (getting ready, on the way, arrived, picked up, completed).
 * A ride may progress only after a provider-verified payment confirmed the booking (confirmed_at) and the payment still stands.
 * Approval and driver assignment alone are not enough. Cancelled/declined/unpaid/failed/refunded bookings never pass, and
 * admin cancellation, reassignment and no-show are separate operations that this rule does not touch.
 */
export function rideMayProgress(b: { confirmed_at?: string | null; payment_status?: string | null; status: string }): boolean {
  if (b.status === "cancelled" || b.status === "rejected" || b.status === "no_show" || b.status === "completed") return false;
  return Boolean(b.confirmed_at) && PAID_STATES.includes(String(b.payment_status));
}
export const AWAITING_PAYMENT_MESSAGE = "This ride cannot start yet: the customer's payment has not been confirmed. You will be able to continue as soon as it is.";

/**
 * "Start Ride" is the driver's first progress step on a ride (status getting_ready). It opens exactly two hours before the
 * scheduled pickup. Leaving for pickup (on_the_way) is a separate step and is NOT time-restricted here.
 * Both the driver API (authoritative, uses the SERVER clock) and the dashboard (display only) use this one function.
 */
export const START_RIDE_STATUS: BookingStatus = "getting_ready";
export const START_WINDOW_MS = 2 * 60 * 60 * 1000;
export function startRideWindow(pickupAt: string | Date | null | undefined, nowMs: number): { allowed: boolean; opensAt: string | null } {
  const t = pickupAt ? new Date(pickupAt).getTime() : NaN;
  if (!Number.isFinite(t)) return { allowed: false, opensAt: null };
  const opens = t - START_WINDOW_MS;
  return { allowed: nowMs >= opens, opensAt: new Date(opens).toISOString() };
}

/** Chat between customer and driver opens once the driver has started the ride or is on the way, and closes with the ride. */
export const CHAT_STATES: BookingStatus[] = ["getting_ready", "on_the_way", "arrived", "picked_up", "in_progress"];
export const chatAllowedForStatus = (s: string) => (CHAT_STATES as string[]).includes(s);

/**
 * Leave for Pickup (on_the_way) is a separate step from Start Ride. A driver may leave before the two-hour Start Ride window,
 * but not days early: it opens `dispatchMinutes` before pickup (admin setting, default 240 = 4 hours, never below the Start Ride window).
 * Start Ride is optional and, if used, comes first; leaving for pickup moves the ride past it.
 */
export const LEAVE_FOR_PICKUP_STATUS: BookingStatus = "on_the_way";
export const DEFAULT_DISPATCH_MINUTES = 240;
export const clampDispatchMinutes = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, START_WINDOW_MS / 60000), 2880) : DEFAULT_DISPATCH_MINUTES;
};
export function leaveForPickupWindow(pickupAt: string | Date | null | undefined, nowMs: number, dispatchMinutes: unknown = DEFAULT_DISPATCH_MINUTES): { allowed: boolean; opensAt: string | null } {
  const t = pickupAt ? new Date(pickupAt).getTime() : NaN;
  if (!Number.isFinite(t)) return { allowed: false, opensAt: null };
  const opens = t - clampDispatchMinutes(dispatchMinutes) * 60000;
  return { allowed: nowMs >= opens, opensAt: new Date(opens).toISOString() };
}
