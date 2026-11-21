import { json, readJson, sameOrigin } from "@/lib/http";
import { getDriverForApi } from "@/lib/driver/auth";
import { getAdminClient } from "@/lib/supabase/admin";
import { AWAITING_PAYMENT_MESSAGE, canTransition, DRIVER_FLOW, rideMayProgress, type BookingStatus } from "@/lib/booking-status";
import { notify } from "@/lib/notify";
import { BUSINESS_TZ } from "@/lib/config";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A driver advances ONE of their own rides to the next valid step. Ownership is part of the query itself (driver_id = the
 * verified driver), so another driver's ride is indistinguishable from a missing one. The update is a compare-and-set on the
 * current status, so a double tap or a concurrent admin change cannot apply twice.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  const driver = await getDriverForApi();
  if (!driver) return json({ error: "Please sign in again." }, 401);
  const db = getAdminClient();
  if (!db) return json({ error: "Database is not configured." }, 503);
  const body = await readJson(request);
  const id = typeof body?.id === "string" && UUID_RE.test(body.id) ? body.id : null;
  const to = typeof body?.status === "string" && (DRIVER_FLOW as string[]).includes(body.status) ? (body.status as BookingStatus) : null;
  if (!id || !to) return json({ error: "Invalid request." }, 400);

  const { data: b } = await db.from("bookings").select("id,reference,status,confirmed_at,payment_status,customer_id,pickup_at,pickup_address,dropoff_address").eq("id", id).eq("driver_id", driver.id).maybeSingle();
  if (!b) return json({ error: "Ride not found." }, 404);
  const from = b.status as BookingStatus;
  if (!canTransition("driver", from, to)) return json({ error: "That step is not available for this ride right now." }, 409);

  // Server-side payment gate: an assigned driver cannot start or progress a ride until a verified payment confirmed the booking.
  if (!rideMayProgress(b)) return json({ error: AWAITING_PAYMENT_MESSAGE, code: "awaiting_payment" }, 409);

  // The update repeats the conditions, so a refund, cancellation or reassignment that lands between the read and the write wins.
  const upd = await db.from("bookings").update({ status: to }).eq("id", id).eq("driver_id", driver.id).eq("status", from).not("confirmed_at", "is", null).in("payment_status", ["paid", "deposit_paid", "partially_refunded"]).select("id");
  if (upd.error || !upd.data?.length) return json({ error: "This ride was just updated. Reload to see its current status." }, 409);
  await db.from("booking_status_history").insert({ booking_id: id, from_status: from, to_status: to, actor_type: "driver", actor_id: driver.id, note: null });

  if (to === "on_the_way" || to === "arrived") {
    const { data: cust } = await db.from("customers").select("name,email").eq("id", b.customer_id).maybeSingle();
    if (cust?.email) {
      const when = new Date(b.pickup_at).toLocaleString("en-US", { timeZone: BUSINESS_TZ, dateStyle: "medium", timeStyle: "short" });
      await notify(db, "booking.status_changed", { type: "booking", id }, { Reference: String(b.reference), Status: to === "on_the_way" ? "Driver on the way" : "Driver arrived", When: when, Pickup: String(b.pickup_address), Destination: b.dropoff_address ?? undefined, _status: to, _customerEmail: cust.email, _customerName: cust.name }, { dedupeSuffix: to });
    }
  }
  return json({ ok: true, status: to });
}
