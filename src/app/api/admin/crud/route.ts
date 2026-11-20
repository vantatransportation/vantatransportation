import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";
import { resources } from "@/lib/admin/resources";
import { coerceValues } from "@/lib/admin/coerce";
import { notify } from "@/lib/notify";
import { EMAIL_RE, phoneDigits } from "@/lib/validation";
import { validateRush, type RushWindow } from "@/lib/pricing/surcharge";
import { canTransition, type BookingStatus } from "@/lib/booking-status";
import { normalizePhotoFields, releaseAsset } from "@/lib/cloudinary";
import { PUBLIC_TABLES, revalidateSite } from "@/lib/admin/revalidate";
import { validateTierPricing } from "@/lib/tier-pricing";
import { BUSINESS_TZ } from "@/lib/config";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dbError(e: { code?: string; message?: string }): Response {
  if (e.code === "23505") return json({ error: "That value is already in use (names, slugs and codes must be unique, and a vehicle can have only one active pricing configuration)." }, 409);
  if (e.code === "23503") return json({ error: "This item is still in use elsewhere. Deactivate it instead of deleting it." }, 409);
  if (e.code === "23514" || e.code === "23502") return json({ error: "One of the values is not allowed. Check the form and try again." }, 422);
  console.error("[admin/crud]", e);
  return json({ error: "The change could not be saved." }, 500);
}

/** Activating a pricing configuration archives the vehicle's previously active one. */
async function archiveOtherActive(db: SupabaseClient, vehicleId: string, exceptId?: string) {
  let q = db.from("pricing_configs").update({ status: "archived" }).eq("vehicle_id", vehicleId).eq("status", "active");
  if (exceptId) q = q.neq("id", exceptId);
  await q;
}

/** Server-side checks for tables whose fields need more than type coercion. Returns an error message or null; may normalise c.data. */
function validateSpecial(table: string, data: Record<string, unknown>, before: Record<string, unknown> | null): string | null {
  if (table === "drivers") {
    if ("email" in data) {
      const email = String(data.email ?? "").trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return "Enter a valid driver email address.";
      data.email = email;
    }
    if ("phone" in data && data.phone && phoneDigits(String(data.phone)).length < 10) return "Enter a valid phone number or leave it blank.";
  }
  if (table === "booking_settings" && Object.keys(data).some((k) => k.startsWith("rush_"))) {
    let windows: unknown = "rush_windows" in data ? data.rush_windows : before?.rush_windows;
    if (typeof windows === "string") { try { windows = JSON.parse(windows); } catch { return "Rush-hour windows must be valid JSON, for example [{\"start\":\"08:00\",\"end\":\"10:00\"}]."; } }
    if (windows == null) windows = [];
    const cand = { enabled: ("rush_enabled" in data ? data.rush_enabled : before?.rush_enabled) !== false, percent: Number("rush_percent" in data ? data.rush_percent : before?.rush_percent ?? 5), windows: windows as RushWindow[], timeZone: String(("rush_timezone" in data ? data.rush_timezone : before?.rush_timezone) || "America/New_York") };
    const bad = validateRush(cand);
    if (bad) return bad;
    if ("rush_windows" in data) data.rush_windows = cand.windows;
    if ("rush_timezone" in data) data.rush_timezone = cand.timeZone;
  }
  return null;
}

export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const { admin, db } = g;

  const body = await readJson(request);
  const resource = typeof body?.resource === "string" ? resources[body.resource] : undefined;
  if (!body || !resource) return json({ error: "Unknown resource." }, 400);
  const action = body.action;
  const id = typeof body.id === "string" && UUID_RE.test(body.id) ? body.id : null;
  const values = (body.values && typeof body.values === "object" ? body.values : {}) as Record<string, unknown>;

  const log = async (act: string, entityId: string | null) => {
    const r = await db.from("activity_logs").insert({ actor_id: admin.id, action: `${resource.slug}.${act}`, entity_type: resource.table, entity_id: entityId, meta: {} });
    if (r.error) console.error("[admin/crud] activity log failed", r.error);
  };
  /** Public pages are cached; refresh them as soon as a public table has really changed. */
  const publish = () => { if (PUBLIC_TABLES.has(resource.table)) revalidateSite(); };

  if (action === "create") {
    if (!resource.canCreate) return json({ error: "Not allowed." }, 403);
    const c = coerceValues(resource, values, false);
    if (!c.ok) return json({ error: c.error }, 422);
    if (resource.sortable) {
      const last = await db.from(resource.table).select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
      c.data.sort_order = ((last.data?.sort_order as number | undefined) ?? 0) + 1;
    }
    { const bad = validateSpecial(resource.table, c.data, null); if (bad) return json({ error: bad }, 422); }
    if (resource.table === "vehicles") { const bad = normalizePhotoFields(c.data); if (bad) return json({ error: bad }, 422); }
    if (resource.table === "pricing_configs" && c.data.status === "active") await archiveOtherActive(db, String(c.data.vehicle_id));
    const ins = await db.from(resource.table).insert(c.data).select("id").single();
    if (ins.error) return dbError(ins.error);
    await log("create", ins.data.id);
    publish();
    return json({ ok: true, id: ins.data.id });
  }

  if (action === "update") {
    if (!id) return json({ error: "Missing id." }, 400);
    const c = coerceValues(resource, values, true);
    if (!c.ok) return json({ error: c.error }, 422);
    if (!Object.keys(c.data).length) return json({ ok: true });

    if (resource.table === "bookings" && c.data.status === "no_show") return json({ error: "Use the Mark as no-show action on the booking page. It records the reason and charges." }, 422);
    const before = await db.from(resource.table).select("*").eq("id", id).maybeSingle();
    if (!before.data) return json({ error: "Not found." }, 404);
    { const bad = validateSpecial(resource.table, c.data, before.data); if (bad) return json({ error: bad }, 422); }
    if (resource.table === "vehicles") { const bad = normalizePhotoFields(c.data, before.data); if (bad) return json({ error: bad }, 422); }
    if (resource.table === "vehicle_tiers") { const bad = validateTierPricing(c.data); if (bad) return json({ error: bad }, 422); }
    if (resource.table === "bookings" && typeof c.data.status === "string" && c.data.status !== before.data.status) {
      // Approval, driver assignment, rejection and cancellation have dedicated checked operations (they release payment, record who
      // acted and notify people). Free-form status edits can only make ordinary, valid progress steps.
      const to = c.data.status as BookingStatus, from = before.data.status as BookingStatus;
      if (["assigned", "rejected", "cancelled"].includes(to) || !canTransition("admin", from, to)) {
        return json({ error: "That status change is not allowed here. Use Approve & assign, Decline or Cancel on the booking page; other changes must follow the ride workflow." }, 422);
      }
      await db.from("booking_status_history").insert({ booking_id: id, from_status: from, to_status: to, actor_type: "admin", actor_id: admin.id, note: "Status edited in Bookings" });
    }

    if (resource.table === "pricing_configs" && c.data.status === "active") {
      await archiveOtherActive(db, String(c.data.vehicle_id ?? before.data.vehicle_id), id);
    }
    // Ask the database to return the row it wrote. An update that matches no row (or is blocked) is NOT a success.
    const upd = await db.from(resource.table).update(c.data).eq("id", id).select("*");
    if (upd.error) return dbError(upd.error);
    const written = (upd.data ?? [])[0] as Record<string, unknown> | undefined;
    if (!written) { console.error("[admin/crud] update matched no row", resource.table, id); return json({ error: "The change was not saved: the record could not be updated. Reload the page and try again." }, 409); }
    if (resource.table === "vehicles" && "image_url" in c.data && (written.image_url ?? null) !== (c.data.image_url ?? null)) {
      console.error("[admin/crud] vehicle image_url did not persist", id);
      return json({ error: "The photo was not saved to the database. Please try again." }, 500);
    }
    await log("update", id);
    publish();
    // A replaced or removed photo is deleted from Cloudinary only when no other vehicle still uses it.
    if (resource.table === "vehicles" && "image_public_id" in c.data && before.data.image_public_id && before.data.image_public_id !== c.data.image_public_id) await releaseAsset(db, before.data.image_public_id);

    // Customer emails on booking status changes. Confirmed, cancelled and no-show are always sent;
    // other statuses only when the "every status change" setting is on. Deduplicated per status.
    if (resource.table === "bookings" && typeof c.data.status === "string" && c.data.status !== before.data.status) {
      const status = c.data.status;
      const always = ["confirmed", "cancelled"].includes(status);
      const setting = always ? null : await db.from("site_content").select("value").eq("key", "settings.notify_status_changes").maybeSingle();
      if (always || setting?.data?.value === true) {
        const cust = await db.from("customers").select("name,email").eq("id", before.data.customer_id).maybeSingle();
        if (cust.data?.email) {
          await notify(db, "booking.status_changed", { type: "booking", id }, {
            Reference: String(before.data.reference), Status: status.replace(/_/g, " "), When: before.data.pickup_at ? new Date(before.data.pickup_at).toLocaleString("en-US", { timeZone: BUSINESS_TZ, dateStyle: "medium", timeStyle: "short" }) : undefined,
            Pickup: String(before.data.pickup_address ?? ""), Destination: before.data.dropoff_address ?? undefined,
            _status: status, _customerEmail: cust.data.email, _customerName: cust.data.name,
          }, { dedupeSuffix: status });
        }
      }
    }
    return json({ ok: true });
  }

  if (action === "delete") {
    if (!id || !resource.canDelete) return json({ error: "Not allowed." }, 403);
    const prior = resource.table === "vehicles" ? await db.from("vehicles").select("image_public_id").eq("id", id).maybeSingle() : null;
    const del = await db.from(resource.table).delete().eq("id", id);
    if (del.error) return dbError(del.error);
    if (prior?.data?.image_public_id) await releaseAsset(db, prior.data.image_public_id);
    await log("delete", id);
    publish();
    return json({ ok: true });
  }

  if (action === "move") {
    if (!id || !resource.sortable) return json({ error: "Not allowed." }, 403);
    const dir = body.direction === "up" ? -1 : 1;
    const rows = await db.from(resource.table).select("id,sort_order").order("sort_order").order("created_at");
    if (rows.error || !rows.data) return dbError(rows.error ?? {});
    const list = rows.data as { id: string; sort_order: number }[];
    const i = list.findIndex((r) => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return json({ ok: true });
    [list[i], list[j]] = [list[j], list[i]];
    const moved = await Promise.all(list.map((r, n) => (r.sort_order !== n + 1 ? db.from(resource.table).update({ sort_order: n + 1 }).eq("id", r.id) : null)));
    const failed = moved.find((m) => m?.error);
    if (failed?.error) return dbError(failed.error);
    publish();
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, 400);
}
