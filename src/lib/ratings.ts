import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { average, parseRating, resolvePoints } from "@/lib/rating-rules";

export type RateResult = { ok: true } | { ok: false; status: number; error: string };
const DUP = "You have already rated this ride.";

/** Customer -> driver. The caller has ALREADY authenticated the customer's credential for `bookingId`; eligibility is re-checked here from the booking itself. */
export async function rateDriver(db: SupabaseClient, bookingId: string, stars: unknown, feedback: unknown): Promise<RateResult> {
  const v = parseRating(stars, feedback);
  if (!v.ok) return { ok: false, status: 422, error: v.error };
  const { data: b } = await db.from("bookings").select("id,status,driver_id,customer_id").eq("id", bookingId).maybeSingle();
  if (!b) return { ok: false, status: 404, error: "Not found." };
  if (b.status !== "completed" || !b.driver_id) return { ok: false, status: 409, error: "You can rate your driver once the ride is completed." };
  const prior = await db.from("driver_ratings").select("id").eq("booking_id", bookingId).maybeSingle();
  if (prior.data) return { ok: false, status: 409, error: DUP };
  const ins = await db.from("driver_ratings").insert({ booking_id: bookingId, driver_id: b.driver_id, customer_id: b.customer_id ?? null, stars: v.stars, feedback: v.feedback });
  if (ins.error) return ins.error.code === "23505" ? { ok: false, status: 409, error: DUP } : (console.error("[rating] insert failed", ins.error.message), { ok: false, status: 500, error: "Could not save your rating. Please try again." });
  return { ok: true };
}

/** Driver -> customer (internal, admin-only). The caller passes the verified driver id; the booking must be THAT driver's completed ride. */
export async function rateCustomer(db: SupabaseClient, driverId: string, bookingId: string, stars: unknown, feedback: unknown): Promise<RateResult> {
  const v = parseRating(stars, feedback);
  if (!v.ok) return { ok: false, status: 422, error: v.error };
  const { data: b } = await db.from("bookings").select("id,status,driver_id,customer_id").eq("id", bookingId).eq("driver_id", driverId).maybeSingle();
  if (!b) return { ok: false, status: 404, error: "Ride not found." };
  if (b.status !== "completed" || !b.customer_id) return { ok: false, status: 409, error: "You can rate the customer once the ride is completed." };
  const prior = await db.from("customer_ratings").select("id").eq("booking_id", bookingId).maybeSingle();
  if (prior.data) return { ok: false, status: 409, error: "You have already rated this customer for this ride." };
  const ins = await db.from("customer_ratings").insert({ booking_id: bookingId, driver_id: driverId, customer_id: b.customer_id, stars: v.stars, feedback: v.feedback });
  if (ins.error) return ins.error.code === "23505" ? { ok: false, status: 409, error: "You have already rated this customer for this ride." } : (console.error("[rating] insert failed", ins.error.message), { ok: false, status: 500, error: "Could not save the rating. Please try again." });
  return { ok: true };
}

export async function driverRatingSummary(db: SupabaseClient, driverId: string): Promise<{ avg: number | null; count: number }> {
  const { data } = await db.from("driver_ratings").select("stars").eq("driver_id", driverId).limit(5000);
  return average((data ?? []).map((r: { stars: number }) => Number(r.stars)));
}

/**
 * Admin-only score change (the route has ALREADY verified the admin). Compare-and-set on the previous score, so two simultaneous
 * adjustments cannot both apply on top of a stale value, plus an append-only history row recording who did it.
 */
export async function adjustPoints(db: SupabaseClient, driverId: string, input: { adjustment?: unknown; newPoints?: unknown; reason?: unknown }, admin: { id: string; email: string }): Promise<{ ok: true; previous: number; next: number } | { ok: false; status: number; error: string }> {
  const { data: d } = await db.from("drivers").select("id,performance_points").eq("id", driverId).maybeSingle();
  if (!d) return { ok: false, status: 404, error: "Driver not found." };
  const r = resolvePoints(Number(d.performance_points), input);
  if (!r.ok) return { ok: false, status: 422, error: r.error };
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) || null : null;
  const upd = await db.from("drivers").update({ performance_points: r.next }).eq("id", driverId).eq("performance_points", r.previous).select("id");
  if (upd.error || !upd.data?.length) return { ok: false, status: 409, error: "The score changed while you were editing. Reload and try again." };
  const h = await db.from("driver_points_history").insert({ driver_id: driverId, previous_points: r.previous, new_points: r.next, adjustment: r.adjustment, reason, admin_user_id: admin.id, admin_email: admin.email });
  if (h.error) console.error("[points] history insert failed", h.error.message);
  return { ok: true, previous: r.previous, next: r.next };
}
