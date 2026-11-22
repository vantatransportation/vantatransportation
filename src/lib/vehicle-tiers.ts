/**
 * Vehicle <-> service tier assignments (many-to-many, table `vehicle_tier_assignments`). Pure helpers plus one loader.
 * No server-only imports, so the same rules are shared by the booking path, the public cards, the admin and the tests.
 *
 * Model: ONE canonical `vehicles` row per vehicle; the tiers it is offered in are rows in `vehicle_tier_assignments`.
 * The legacy column `vehicles.tier_id` is DEPRECATED. It is no longer the source of truth: the app only MIRRORS a vehicle's first
 * tier (lowest sort order) into it when an admin saves tiers, so a rollback to the previous release still shows a sensible tier.
 * It is READ only as a fallback when the assignments table cannot be read, e.g. the site was deployed before migration 0010
 * was applied, so the public site and the booking flow keep working in single-tier mode instead of failing.
 *
 * IMPORTANT (PostgREST): never embed `vehicle_tiers(...)` inside a `vehicles` select any more. With a direct FK AND a junction
 * table between the same two tables the embed is ambiguous and the whole request fails. Embed `vehicle_tier_assignments(...)`
 * or use the loader below.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface TierRow {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  /** Fixed price charged online for this tier, in cents (null = not configured yet). */
  fixedPriceCents: number | null;
  /** Airport Meet & Greet fee for this tier, in cents (null = not offered). */
  meetGreetFeeCents: number | null;
}

export const TIER_COLUMNS = "id,name,slug,sort_order,is_active,fixed_price_cents,meet_greet_fee_cents";
export const TIER_ASSIGNMENT_SELECT = `vehicle_id,tier_id,vehicle_tiers(${TIER_COLUMNS})`;
export const MAX_TIERS_PER_VEHICLE = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Maps one `vehicle_tiers` row. Inactive tiers and malformed rows map to null (an inactive tier is treated as absent). */
export function toTierRow(t: Row | null | undefined): TierRow | null {
  if (!t || typeof t !== "object" || typeof t.id !== "string" || t.is_active === false) return null;
  return {
    id: t.id, name: String(t.name ?? ""), slug: String(t.slug ?? ""), sortOrder: Number(t.sort_order ?? 0),
    fixedPriceCents: t.fixed_price_cents ?? null, meetGreetFeeCents: t.meet_greet_fee_cents ?? null,
  };
}

const byTierOrder = (a: TierRow, b: TierRow) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

/** Removes duplicate tiers (same id) and orders them. A vehicle never lists the same tier twice. */
export function dedupeTiers(tiers: TierRow[]): TierRow[] {
  const seen = new Map<string, TierRow>();
  for (const t of tiers) if (!seen.has(t.id)) seen.set(t.id, t);
  return [...seen.values()].sort(byTierOrder);
}

/** Groups assignment rows (with their embedded tier) by vehicle id. Duplicates are collapsed, inactive tiers dropped. */
export function groupAssignments(rows: Row[] | null | undefined): Map<string, TierRow[]> {
  const out = new Map<string, TierRow[]>();
  for (const r of rows ?? []) {
    const embedded = Array.isArray(r.vehicle_tiers) ? r.vehicle_tiers[0] : r.vehicle_tiers;
    const tier = toTierRow(embedded);
    if (!tier || typeof r.vehicle_id !== "string") continue;
    out.set(r.vehicle_id, [...(out.get(r.vehicle_id) ?? []), tier]);
  }
  for (const [k, v] of out) out.set(k, dedupeTiers(v));
  return out;
}

export interface VehicleTierMap { byVehicle: Map<string, TierRow[]>; source: "assignments" | "legacy" }

/**
 * Loads the tiers of the given vehicles. Never throws. When the assignments table cannot be read it logs the reason and
 * falls back to each vehicle's legacy `tier_id`, so a deployment that is ahead of the migration degrades gracefully.
 */
export async function loadVehicleTiers(db: SupabaseClient, vehicles: { id: string; tier_id?: string | null }[]): Promise<VehicleTierMap> {
  try {
    const a = await db.from("vehicle_tier_assignments").select(TIER_ASSIGNMENT_SELECT);
    if (!a.error) return { byVehicle: groupAssignments(a.data as Row[] | null), source: "assignments" };
    console.error("[tiers] could not read vehicle_tier_assignments (has migration 0010 been applied?); using each vehicle's legacy single tier", a.error.message);
  } catch (e) {
    console.error("[tiers] reading vehicle_tier_assignments threw; using each vehicle's legacy single tier", e);
  }
  const byVehicle = new Map<string, TierRow[]>();
  try {
    const t = await db.from("vehicle_tiers").select(TIER_COLUMNS);
    const tiers = new Map<string, TierRow>();
    for (const row of (t.data ?? []) as Row[]) { const m = toTierRow(row); if (m) tiers.set(m.id, m); }
    for (const v of vehicles) { const m = v.tier_id ? tiers.get(v.tier_id) : undefined; if (m) byVehicle.set(v.id, [m]); }
  } catch (e) {
    console.error("[tiers] legacy tier fallback failed; vehicles are shown without tiers", e);
  }
  return { byVehicle, source: "legacy" };
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const vehicleInTier = (tiers: { id: string }[], tierId: string | null | undefined): boolean => Boolean(tierId) && tiers.some((t) => sameId(t.id, tierId as string));

/** The vehicles offered in one tier. A vehicle appears once even if its tier list were malformed. */
export function vehiclesInTier<T extends { id: string; tiers: { id: string }[] }>(vehicles: T[], tierId: string | null | undefined): T[] {
  const seen = new Set<string>();
  return vehicles.filter((v) => {
    if (seen.has(v.id) || !vehicleInTier(v.tiers, tierId)) return false;
    seen.add(v.id);
    return true;
  });
}

/**
 * The distinct tiers offered by the given vehicles (what the calculator shows as choices), in `order` (the tiers' sort order) when
 * known, otherwise by name. A tier with no vehicle is not offered; a tier shared by several vehicles appears once.
 */
export function tierChoicesFrom<T extends { id: string; name: string }>(vehicles: { tiers: T[] }[], order: { id: string }[] = []): T[] {
  const seen = new Map<string, T>();
  for (const v of vehicles) for (const t of v.tiers) if (!seen.has(t.id)) seen.set(t.id, t);
  const rank = (id: string) => { const i = order.findIndex((o) => o.id === id); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
  return [...seen.values()].sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

/** Tiers that have at least one vehicle, in tier order. */
export function tiersWithVehicles<T extends { tiers: TierRow[] }>(vehicles: T[]): TierRow[] {
  return dedupeTiers(vehicles.flatMap((v) => v.tiers));
}

export type TierChoice =
  | { ok: true; tier: TierRow | null }
  | { ok: false; code: "tier_required" | "tier_invalid" | "no_tier"; error: string };

/**
 * Decides which tier a booking is made in.
 *  - A tier id sent by the client must be one of the vehicle's assigned tiers. Anything else is rejected (a vehicle/tier
 *    combination the business does not offer must never reach the database).
 *  - No tier id: allowed only when the vehicle has exactly one tier (older browser sessions and API clients).
 *  - A vehicle with no tier cannot be booked by customers. Staff conversions of an agreed quote (`allowUntiered`) may use it.
 */
export function resolveTierChoice(vehicleTiers: TierRow[], requestedTierId: string | null | undefined, opts: { allowUntiered?: boolean } = {}): TierChoice {
  const tiers = dedupeTiers(vehicleTiers);
  if (requestedTierId) {
    const t = tiers.find((x) => sameId(x.id, requestedTierId));
    return t ? { ok: true, tier: t } : { ok: false, code: "tier_invalid", error: "That vehicle is not offered in the selected service tier. Please choose another vehicle or tier." };
  }
  if (tiers.length === 1) return { ok: true, tier: tiers[0] };
  if (tiers.length > 1) return { ok: false, code: "tier_required", error: "Please choose a service tier for this vehicle." };
  return opts.allowUntiered ? { ok: true, tier: null } : { ok: false, code: "no_tier", error: "That vehicle is not available in any service tier. Please choose another." };
}

/** Normalises the admin form's tier selection: an array of UUIDs, deduplicated and bounded. */
export function parseTierIds(raw: unknown): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, ids: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "Tiers must be a list of tiers." };
  const ids: string[] = [];
  for (const v of raw) {
    if (!isUuid(v)) return { ok: false, error: "One of the selected tiers is invalid." };
    const id = v.toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_TIERS_PER_VEHICLE) return { ok: false, error: "Too many tiers selected." };
  return { ok: true, ids };
}

/** What has to be inserted and deleted to turn `current` into `desired`. Inserts run first so a failure never leaves a vehicle with fewer tiers than intended. */
export function diffTierIds(current: string[], desired: string[]): { add: string[]; remove: string[] } {
  const cur = new Set(current.map((s) => s.toLowerCase()));
  const want = new Set(desired.map((s) => s.toLowerCase()));
  return { add: [...want].filter((id) => !cur.has(id)), remove: [...cur].filter((id) => !want.has(id)) };
}

/** Attaches `tier_ids` and `tier_names` to admin vehicle rows (the form and the list read these). Retired (inactive) tiers are left out: they cannot be chosen. */
export async function attachVehicleTiers<T extends { id: unknown }>(db: SupabaseClient, rows: T[]): Promise<(T & { tier_ids: string[]; tier_names: string[] })[]> {
  const a = await db.from("vehicle_tier_assignments").select("vehicle_id,tier_id,vehicle_tiers(id,name,sort_order,is_active)");
  if (a.error) console.error("[admin] could not read vehicle tier assignments (has migration 0010 been applied?)", a.error.message);
  const by = new Map<string, { id: string; name: string; order: number }[]>();
  for (const r of (a.data ?? []) as Row[]) {
    const t = Array.isArray(r.vehicle_tiers) ? r.vehicle_tiers[0] : r.vehicle_tiers;
    if (!t || t.is_active === false || typeof r.vehicle_id !== "string") continue; // retired tiers cannot be assigned or shown
    by.set(r.vehicle_id, [...(by.get(r.vehicle_id) ?? []), { id: String(t.id), name: String(t.name ?? ""), order: Number(t.sort_order ?? 0) }]);
  }
  return rows.map((row) => {
    const list = (by.get(String(row.id)) ?? []).sort((x, y) => x.order - y.order || x.name.localeCompare(y.name));
    return { ...row, tier_ids: list.map((t) => t.id), tier_names: list.map((t) => t.name) };
  });
}

export type TierSelectionCheck = { ok: true; active: Map<string, number> } | { ok: false; status: number; error: string };

/**
 * Validates a tier selection BEFORE anything is written: every id must be an existing, active tier. Returns the active tiers
 * (id -> sort order) so the caller can apply the change without a second read.
 */
export async function checkTierSelection(db: SupabaseClient, desired: string[]): Promise<TierSelectionCheck> {
  const t = await db.from("vehicle_tiers").select("id,sort_order,is_active");
  if (t.error) { console.error("[tiers] could not read vehicle_tiers", t.error.message); return { ok: false, status: 500, error: "Could not check the selected tiers. Please try again." }; }
  const active = new Map<string, number>();
  for (const r of (t.data ?? []) as Row[]) if (r.is_active !== false && typeof r.id === "string") active.set(r.id.toLowerCase(), Number(r.sort_order ?? 0));
  if (desired.some((id) => !active.has(id.toLowerCase()))) return { ok: false, status: 422, error: "One of the selected tiers is not available. Reload the page and try again." };
  return { ok: true, active };
}

export type SaveTiersResult = { ok: true; tierIds: string[]; added: string[]; removed: string[] } | { ok: false; status: number; error: string };

/**
 * Makes `desired` the vehicle's set of ACTIVE tiers. Adds run first, then removals, so a failure part-way never leaves the vehicle
 * with fewer tiers than it had; a duplicate-key error from a concurrent save is harmless. Links to retired (inactive) tiers are
 * never touched. Finally the first tier (lowest sort order) is mirrored into the deprecated `vehicles.tier_id`.
 */
export async function applyVehicleTiers(db: SupabaseClient, vehicleId: string, desired: string[], active: Map<string, number>): Promise<SaveTiersResult> {
  const want = [...new Set(desired.map((d) => d.toLowerCase()))];
  const cur = await db.from("vehicle_tier_assignments").select("tier_id").eq("vehicle_id", vehicleId);
  if (cur.error) {
    console.error("[tiers] could not read assignments", cur.error.message);
    return { ok: false, status: 500, error: "Could not save the tiers. Has migration 0010 been applied?" };
  }
  const current = ((cur.data ?? []) as Row[]).map((r) => String(r.tier_id).toLowerCase()).filter((id) => active.has(id));
  const { add, remove } = diffTierIds(current, want);
  if (add.length) {
    const ins = await db.from("vehicle_tier_assignments").insert(add.map((tier_id) => ({ vehicle_id: vehicleId, tier_id })));
    if (ins.error && ins.error.code !== "23505") { console.error("[tiers] insert failed", ins.error.message); return { ok: false, status: 500, error: "Could not save the tiers. Please try again." }; }
  }
  if (remove.length) {
    const del = await db.from("vehicle_tier_assignments").delete().eq("vehicle_id", vehicleId).in("tier_id", remove);
    if (del.error) { console.error("[tiers] delete failed", del.error.message); return { ok: false, status: 500, error: "Could not remove the tier. Please try again." }; }
  }
  const first = [...want].sort((a, b) => (active.get(a) ?? 0) - (active.get(b) ?? 0))[0] ?? null;
  const mirror = await db.from("vehicles").update({ tier_id: first }).eq("id", vehicleId);
  if (mirror.error) console.error("[tiers] could not mirror the first tier into vehicles.tier_id (harmless)", mirror.error.message);
  return { ok: true, tierIds: want, added: add, removed: remove };
}
