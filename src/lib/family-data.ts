import "server-only";
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "@/lib/supabase/admin";
import { getPublicClient } from "@/lib/supabase/public";
import { FAMILY_KEYS, familyKey } from "@/lib/family-section";

/** The six site_content keys that make up the Family section (family_section.enabled / title / subtitle / body / closing / image). */
export const FAMILY_ROW_KEYS: string[] = FAMILY_KEYS.map((k) => familyKey(k));

/**
 * Reads the Family rows with ONE client. Selecting by exact key list (not LIKE) means "_" is never a wildcard and nothing else
 * is read. Throws on a database error so callers can fall back to the next client. `hidden` lists rows the anonymous key
 * cannot see (group_name "Settings" is excluded from public reads by RLS).
 */
export async function readFamilyRows(db: SupabaseClient): Promise<{ content: Record<string, unknown>; hidden: string[] }> {
  const { data, error } = await db.from("site_content").select("key,value,group_name").in("key", FAMILY_ROW_KEYS);
  if (error) throw error;
  const content: Record<string, unknown> = {};
  const hidden: string[] = [];
  for (const r of (data ?? []) as { key: string; value: unknown; group_name?: string | null }[]) {
    content[r.key] = r.value;
    if (r.group_name === "Settings") hidden.push(r.key);
  }
  return { content, hidden };
}

const message = (e: unknown) => (e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e));

/**
 * Stored Family content for the public home page (only the family_section.* keys).
 *
 * Why this is separate from getSiteData(): getSiteData() reads ALL site content with the anonymous key inside one Promise.all
 * together with FAQs and standards, and returns the built-in defaults for everything when any of those reads fails, when the anon
 * key is missing, or when RLS hides a row. For this section the defaults are exactly "the old text and the Vanta mark", so an
 * edit that WAS saved looked as if it had not been. Same remedy as the fleet photos (loadFleetData): the server-side client
 * is tried first (it reads only these six rows, so nothing else is exposed), then the anonymous client. When neither can read
 * this returns {} and the section shows its built-in defaults; the reason is logged.
 */
export const loadFamilyContent = cache(async (): Promise<Record<string, unknown>> => {
  const attempts: { via: "service" | "public"; db: SupabaseClient | null }[] = [
    { via: "service", db: getAdminClient() },
    { via: "public", db: getPublicClient() },
  ];
  for (const { via, db } of attempts) {
    if (!db) continue;
    try {
      const { content, hidden } = await readFamilyRows(db);
      if (hidden.length) console.warn(`[site] family section rows are hidden from public reads (group_name "Settings"): ${hidden.join(", ")}. Rendered via the ${via} client; saving once in Admin, Family section moves them back to "Home".`);
      console.info(`[site] family section loaded via ${via} client: ${Object.keys(content).length}/${FAMILY_ROW_KEYS.length} stored values`);
      return content;
    } catch (e) {
      console.error(`[site] family section read failed via ${via} client: ${message(e)}`);
    }
  }
  console.error("[site] family section could not be read with any Supabase client (check NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY); showing the built-in Family text and the Vanta mark");
  return {};
});
