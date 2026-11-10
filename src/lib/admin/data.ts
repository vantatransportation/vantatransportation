import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resources, type Resource } from "./resources";
import { requireAdmin } from "./auth";
import { getAdminClient } from "@/lib/supabase/admin";

/** Every admin page calls this: layouts do not re-run on client navigation, so each page re-checks access. */
export async function adminPage() {
  const admin = await requireAdmin();
  const db = getAdminClient();
  if (!db) throw new Error("Supabase is not configured");
  return { admin, db };
}

export type Row = Record<string, unknown>;

export async function listRows(db: SupabaseClient, r: Resource, limit = 500): Promise<Row[]> {
  const { data, error } = await db.from(r.table).select(r.select).order(r.orderBy, { ascending: r.ascending ?? true }).limit(limit);
  if (error) {
    console.error(`[admin] list ${r.slug} failed`, error);
    return [];
  }
  return (data ?? []) as unknown as Row[];
}

export async function loadRefOptions(db: SupabaseClient, r: Resource): Promise<Record<string, { id: string; label: string }[]>> {
  const out: Record<string, { id: string; label: string }[]> = {};
  for (const f of r.fields) {
    if (f.type !== "ref" || !f.ref || out[f.ref]) continue;
    const target = resources[f.ref];
    if (!target) continue;
    const rows = await listRows(db, target, 1000);
    out[f.ref] = rows.map((row) => ({ id: String(row.id), label: target.refLabel ? target.refLabel(row) : String(row.id) }));
  }
  return out;
}
