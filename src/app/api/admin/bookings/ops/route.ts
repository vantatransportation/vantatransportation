import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";
import { notify } from "@/lib/notify";
import { clean } from "@/lib/validation";
import { loadBookingSettings } from "@/lib/policies";
import { waitingCharge } from "@/lib/pricing/roundtrip";
import { BUSINESS_TZ } from "@/lib/config";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAY = ["none", "pending", "invoiced", "paid", "waived"];
const cents = (v: unknown): number | null | "bad" => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1_000_000 ? Math.round(n * 100) : "bad";
};

/**
 * Staff-only booking operations: no-show, waiting charges, fulfilment/partner details, Meet & Greet confirmation.
 * Records who did it and never charges a payment method: it only records amounts and payment status.
 */
export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const body = await readJson(request);
  const id = typeof body?.id === "string" && UUID_RE.test(body.id) ? body.id : null;
  if (!id) return json({ error: "Missing booking." }, 400);
  const { data: b } = await g.db.from("bookings").select("id,reference,status,customer_id,pickup_at,pickup_address,dropoff_address").eq("id", id).maybeSingle();
  if (!b) return json({ error: "Booking not found." }, 404);
  const log = (action: string, meta: Record<string, unknown> = {}) => g.db.from("activity_logs").insert({ actor_id: g.admin.id, action, entity_type: "booking", entity_id: id, meta });

  switch (body?.action) {
    case "no_show": {
      const reason = clean(body.reason, 500);
      if (reason.length < 3) return json({ error: "Enter the reason for marking a no-show." }, 422);
      const charge = cents(body.chargeDollars);
      if (charge === "bad") return json({ error: "Enter a valid charge amount or leave it blank." }, 422);
      const status = typeof body.chargeStatus === "string" && PAY.includes(body.chargeStatus) ? body.chargeStatus : "none";
      const upd = await g.db.from("bookings").update({
        status: "no_show", no_show_at: new Date().toISOString(), no_show_reason: reason, no_show_marked_by: g.admin.id, no_show_marked_by_email: g.admin.email,
        no_show_charge_cents: charge, no_show_charge_status: status,
      }).eq("id", id);
      if (upd.error) return json({ error: "Could not save." }, 500);
      await log("booking.no_show", { reason, charge, status });
      const cust = await g.db.from("customers").select("name,email").eq("id", b.customer_id).maybeSingle();
      if (cust.data?.email) {
        await notify(g.db, "booking.status_changed", { type: "booking", id }, {
          Reference: String(b.reference), Status: "no show", Pickup: String(b.pickup_address ?? ""), Destination: b.dropoff_address ?? undefined,
          When: b.pickup_at ? new Date(b.pickup_at).toLocaleString("en-US", { timeZone: BUSINESS_TZ, dateStyle: "medium", timeStyle: "short" }) : undefined,
          _status: "no_show", _customerEmail: cust.data.email, _customerName: cust.data.name,
        }, { dedupeSuffix: "no_show" });
      }
      return json({ ok: true });
    }
    case "waiting": {
      const minutes = Number(body.minutesWaited);
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) return json({ error: "Enter the minutes the driver waited." }, 422);
      const s = await loadBookingSettings(g.db);
      const calc = waitingCharge(Math.floor(minutes), s.waitingIncludedMinutes, s.waitingIncrementMinutes, s.waitingRateCents);
      const override = cents(body.chargeDollars);
      if (override === "bad") return json({ error: "Enter a valid charge amount or leave it blank." }, 422);
      const finalCents = override ?? calc.cents; // staff may enter an amount; otherwise only an approved rate is used
      const status = typeof body.chargeStatus === "string" && PAY.includes(body.chargeStatus) ? body.chargeStatus : finalCents ? "pending" : "none";
      const upd = await g.db.from("bookings").update({ waiting_minutes_billed: calc.billableMinutes, waiting_charge_cents: finalCents, waiting_charge_status: status }).eq("id", id);
      if (upd.error) return json({ error: "Could not save." }, 500);
      await log("booking.waiting_recorded", { minutes, billable: calc.billableMinutes, cents: finalCents, status });
      return json({ ok: true, billableMinutes: calc.billableMinutes, chargeCents: finalCents, rateApproved: s.waitingRateCents != null });
    }
    case "fulfilment": {
      const mode = ["vanta", "partner", "review"].includes(String(body.mode)) ? String(body.mode) : null;
      if (!mode) return json({ error: "Choose a fulfilment option." }, 422);
      const upd = await g.db.from("bookings").update({ fulfilment_mode: mode, partner_name: clean(body.partnerName, 120) || null, requires_manual_review: mode === "review" }).eq("id", id);
      if (upd.error) return json({ error: "Could not save." }, 500);
      await log("booking.fulfilment", { mode });
      return json({ ok: true });
    }
    case "meet_greet": {
      const st = ["requested", "confirmed", "declined"].includes(String(body.status)) ? String(body.status) : null;
      if (!st) return json({ error: "Choose a status." }, 422);
      const charge = cents(body.chargeDollars);
      if (charge === "bad") return json({ error: "Enter a valid charge amount or leave it blank." }, 422);
      const upd = await g.db.from("booking_airport_details").update({ meet_greet_status: st, ...(charge !== null ? { meet_greet_charge_cents: charge } : {}) }).eq("booking_id", id).eq("meet_greet_requested", true);
      if (upd.error) return json({ error: "Could not save." }, 500);
      await log("booking.meet_greet", { status: st });
      return json({ ok: true });
    }
  }
  return json({ error: "Unknown action." }, 400);
}
