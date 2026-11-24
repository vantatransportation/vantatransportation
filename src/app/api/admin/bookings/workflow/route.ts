import { driverEmailFields } from "@/lib/driver/email";
import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";
import { notify } from "@/lib/notify";
import { clean } from "@/lib/validation";
import { BUSINESS_TZ } from "@/lib/config";
import { AWAITING_PAYMENT_MESSAGE, AWAITING_REVIEW, DRIVER_FLOW, canApprove, canAssign, canTransition, rideMayProgress, type BookingStatus } from "@/lib/booking-status";
import { formatMoney } from "@/lib/pricing/engine";
import { availableProviders } from "@/lib/payment-providers";
import { loadBookingSettings } from "@/lib/policies";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BOOKING_COLS = "id,reference,status,customer_id,driver_id,pickup_at,pickup_address,dropoff_address,passengers,checked_bags,carry_on_bags,payment_status,payment_token,tracking_code,confirmed_at,online_amount_cents,currency,payment_released_at";

/**
 * Admin-only booking workflow: approve + assign a driver (releases payment), reassign, reject, cancel.
 * Every state change is a conditional update ("claim"), so two admins acting at once cannot both succeed.
 * Emails are sent only after the database change succeeded and are de-duplicated per assignment.
 */
export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const body = await readJson(request);
  const id = typeof body?.id === "string" && UUID_RE.test(body.id) ? body.id : null;
  if (!id) return json({ error: "Missing booking." }, 400);
  const { data: b } = await g.db.from("bookings").select(BOOKING_COLS).eq("id", id).maybeSingle();
  if (!b) return json({ error: "Booking not found." }, 404);
  const status = b.status as BookingStatus;

  const history = (from: string | null, to: string, note?: string) =>
    g.db.from("booking_status_history").insert({ booking_id: id, from_status: from, to_status: to, actor_type: "admin", actor_id: g.admin.id, note: note ?? null });
  const log = (action: string, meta: Record<string, unknown> = {}) => g.db.from("activity_logs").insert({ actor_id: g.admin.id, action, entity_type: "booking", entity_id: id, meta });
  const when = b.pickup_at ? new Date(b.pickup_at).toLocaleString("en-US", { timeZone: BUSINESS_TZ, dateStyle: "medium", timeStyle: "short" }) : undefined;
  const luggage = b.checked_bags != null || b.carry_on_bags != null ? `${b.checked_bags ?? 0} checked, ${b.carry_on_bags ?? 0} carry-on` : undefined;
  const customer = async () => (await g.db.from("customers").select("name,email").eq("id", b.customer_id).maybeSingle()).data as Row | null;
  const driverOf = async (driverId: string) => (await g.db.from("drivers").select("id,full_name,first_name,preferred_name,email,phone,vehicle_plate,is_active").eq("id", driverId).maybeSingle()).data as Row | null;

  switch (body?.action) {
    case "approve_assign":
    case "reassign": {
      const isApprove = body.action === "approve_assign";
      const driverId = typeof body.driverId === "string" && UUID_RE.test(body.driverId) ? body.driverId : null;
      if (!driverId) return json({ error: "Choose a driver." }, 422);
      if (isApprove ? !canApprove(status) : !(canAssign(status) && b.driver_id)) {
        return json({ error: isApprove ? "This booking was already reviewed." : "A driver can be changed only before the passenger is picked up." }, 409);
      }
      if (!isApprove && b.driver_id === driverId) return json({ error: "That driver is already assigned." }, 409);
      const driver = await driverOf(driverId);
      if (!driver) return json({ error: "Driver not found." }, 404);
      if (!driver.is_active) return json({ error: "That driver is not active." }, 422);
      const now = new Date().toISOString();
      const previous = b.driver_id as string | null;

      // 1. Close the current assignment (reassign only). Zero rows means another admin changed it first.
      if (!isApprove) {
        const closed = await g.db.from("booking_assignments").update({ unassigned_at: now, unassigned_reason: "reassigned" }).eq("booking_id", id).eq("driver_id", previous).is("unassigned_at", null).select("id");
        if (closed.error || !closed.data?.length) return json({ error: "This booking was just changed by someone else. Reload and try again." }, 409);
      }
      // 2. Create the new assignment. The database allows only one open assignment per booking.
      const assignment = await g.db.from("booking_assignments").insert({ booking_id: id, driver_id: driverId, assigned_by: g.admin.id, assigned_at: now }).select("id").single();
      if (assignment.error) {
        if (!isApprove && previous) await g.db.from("booking_assignments").insert({ booking_id: id, driver_id: previous, assigned_by: g.admin.id, assigned_at: now }); // restore
        return json({ error: assignment.error.code === "23505" ? "Another assignment was just made for this booking. Reload and try again." : "Could not save the assignment." }, assignment.error.code === "23505" ? 409 : 500);
      }
      // 3. Update the booking only if it is still in the state we read (compare-and-set).
      let q = g.db.from("bookings").update(isApprove
        ? { status: "assigned", driver_id: driverId, approved_at: now, approved_by: g.admin.id, payment_released_at: now }
        : { driver_id: driverId }).eq("id", id);
      q = isApprove ? q.in("status", AWAITING_REVIEW).is("driver_id", null) : q.eq("driver_id", previous);
      const upd = await q.select("id");
      if (upd.error || !upd.data?.length) {
        await g.db.from("booking_assignments").update({ unassigned_at: now, unassigned_reason: "claim failed" }).eq("id", assignment.data.id);
        return json({ error: "This booking was just changed by someone else. Reload and try again." }, 409);
      }
      await history(status, isApprove ? "assigned" : status, isApprove ? `Approved and assigned to ${driver.full_name}` : `Reassigned to ${driver.full_name}`);
      await log(isApprove ? "booking.approved" : "booking.reassigned", { driverId, previous });

      // Emails only after the change is saved. Keys include the assignment id so a retry never duplicates and a later reassignment still notifies.
      const cust = await customer();
      const ref = String(b.reference);
      const common = { Reference: ref, When: when, Pickup: String(b.pickup_address ?? ""), Destination: b.dropoff_address ?? undefined };
      const site = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/$/, "");
      if (isApprove && cust?.email) {
        const settings = await loadBookingSettings(g.db);
        const payable = availableProviders(settings).length > 0 && b.online_amount_cents != null && b.payment_token && site;
        await notify(g.db, "booking.approved", { type: "booking", id }, {
          ...common, // driver details are emailed only once the booking is confirmed by verified payment (see booking.confirmed)
          "Booking page": site && b.tracking_code ? `${site}/track#id=${b.tracking_code}` : undefined, _trackingId: b.tracking_code ?? undefined, "Amount due online": b.online_amount_cents != null ? formatMoney(b.online_amount_cents, b.currency ?? "USD") : undefined,
          _customerEmail: cust.email, _customerName: cust.name, _payUrl: payable ? `${site}/pay/${b.payment_token}` : undefined,
        }, { dedupeSuffix: assignment.data.id });
      }
      // A reassignment is told to the customer only when the booking is already confirmed and paid (the customer has seen driver details).
      // Before that no driver details were shared, so there is nothing to correct, and the confirmation email will carry the current driver.
      if (!isApprove && cust?.email && b.confirmed_at) {
        await notify(g.db, "booking.reassigned", { type: "booking", id }, { ...common, ...(await driverEmailFields(g.db, driverId)), _customerEmail: cust.email, _customerName: cust.name }, { dedupeSuffix: assignment.data.id });
      }
      if (!isApprove && previous) {
        const old = await driverOf(previous);
        if (old?.email) await notify(g.db, "driver.unassigned", { type: "booking", id }, { Reference: ref, When: when, _driverEmail: old.email, _driverName: old.full_name }, { dedupeSuffix: assignment.data.id });
      }
      await notify(g.db, "driver.assigned", { type: "booking", id }, { ...common, Passengers: String(b.passengers), Luggage: luggage, _driverEmail: driver.email, _driverName: driver.full_name, _driverUrl: site ? `${site}/driver` : undefined }, { dedupeSuffix: assignment.data.id });
      return json({ ok: true, status: isApprove ? "assigned" : status, driver: driver.full_name });
    }

    case "reject": {
      if (!canApprove(status)) return json({ error: "Only requests awaiting review can be declined." }, 409);
      const reason = clean(body.reason, 500);
      if (reason.length < 3) return json({ error: "Enter the reason. It is included in the email to the customer." }, 422);
      const now = new Date().toISOString();
      const upd = await g.db.from("bookings").update({ status: "rejected", rejected_at: now, rejection_reason: reason, payment_released_at: null }).eq("id", id).in("status", AWAITING_REVIEW).select("id");
      if (upd.error || !upd.data?.length) return json({ error: "This booking was already reviewed." }, 409);
      await history(status, "rejected", reason); await log("booking.rejected", { reason });
      const cust = await customer();
      if (cust?.email) await notify(g.db, "booking.rejected", { type: "booking", id }, { Reference: String(b.reference), When: when, Pickup: String(b.pickup_address ?? ""), Destination: b.dropoff_address ?? undefined, Reason: reason, _customerEmail: cust.email, _customerName: cust.name });
      return json({ ok: true, status: "rejected" });
    }

    case "cancel": {
      if (!canTransition("admin", status, "cancelled")) return json({ error: "This booking can no longer be cancelled here." }, 409);
      const reason = clean(body.reason, 500);
      if (reason.length < 3) return json({ error: "Enter the cancellation reason." }, 422);
      const now = new Date().toISOString();
      const upd = await g.db.from("bookings").update({ status: "cancelled", cancelled_at: now, cancellation_reason: reason, payment_released_at: null }).eq("id", id).eq("status", status).select("id");
      if (upd.error || !upd.data?.length) return json({ error: "This booking was just changed by someone else. Reload and try again." }, 409);
      const prev = b.driver_id as string | null;
      await g.db.from("booking_assignments").update({ unassigned_at: now, unassigned_reason: "booking cancelled" }).eq("booking_id", id).is("unassigned_at", null);
      await history(status, "cancelled", reason); await log("booking.cancelled", { reason });
      const cust = await customer();
      if (cust?.email) await notify(g.db, "booking.status_changed", { type: "booking", id }, { Reference: String(b.reference), Status: "cancelled", Pickup: String(b.pickup_address ?? ""), Destination: b.dropoff_address ?? undefined, When: when, _status: "cancelled", _customerEmail: cust.email, _customerName: cust.name }, { dedupeSuffix: "cancelled" });
      if (prev) { const d = await driverOf(prev); if (d?.email) await notify(g.db, "driver.unassigned", { type: "booking", id }, { Reference: String(b.reference), When: when, _driverEmail: d.email, _driverName: d.full_name }, { dedupeSuffix: "cancelled" }); }
      // No refund is issued or promised automatically: a refund needs a defined policy and a deliberate admin action in Stripe/PayPal.
      const paid = ["paid", "deposit_paid", "partially_refunded"].includes(String(b.payment_status));
      return json({ ok: true, status: "cancelled", refundReviewNeeded: paid });
    }
    case "advance": {
      // Admin may move a ride through the same driver steps (for example to complete a ride a driver could not). Never to
      // assigned / confirmed (those come from approval and verified payment), and never out of a terminal state.
      const to = typeof body.status === "string" && (DRIVER_FLOW as string[]).includes(body.status) && body.status !== "assigned" ? (body.status as BookingStatus) : null;
      if (!to) return json({ error: "Choose a valid next step." }, 422);
      if (!canTransition("admin", status, to)) return json({ error: "That step is not valid from the current status." }, 409);
      if (!rideMayProgress(b)) return json({ error: AWAITING_PAYMENT_MESSAGE.replace("You will be able to continue", "The ride can continue"), code: "awaiting_payment" }, 409);
      const upd = await g.db.from("bookings").update({ status: to }).eq("id", id).eq("status", status).not("confirmed_at", "is", null).in("payment_status", ["paid", "deposit_paid", "partially_refunded"]).select("id");
      if (upd.error || !upd.data?.length) return json({ error: "This booking was just changed by someone else. Reload and try again." }, 409);
      await history(status, to, "Updated by admin"); await log("booking.advanced", { from: status, to });
      return json({ ok: true, status: to });
    }
    default:
      return json({ error: "Unknown action." }, 400);
  }
}
