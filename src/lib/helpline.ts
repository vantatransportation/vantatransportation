import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The ONLY phone number customer-facing screens may offer for calling: the official Vanta helpline.
 * Source, in order: the admin-editable website setting "contact.phone" (Admin > Website content), then the optional
 * HELPLINE_PHONE environment variable. Nothing is invented: if neither is set the customer screens show no call button
 * and the admin dashboard shows a setup warning. Customer and driver numbers are never turned into tel: links.
 */
export interface Helpline { display: string; tel: string }

export function parseHelpline(value: unknown): Helpline | null {
  if (typeof value !== "string") return null;
  const display = value.trim().slice(0, 40);
  const digits = display.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  const plus = display.startsWith("+") || digits.length > 10;
  const tel = plus ? `+${digits}` : `+1${digits}`; // a bare 10-digit number is treated as a North American number
  return { display, tel };
}

export async function getHelpline(db: SupabaseClient): Promise<Helpline | null> {
  try {
    const { data } = await db.from("site_content").select("value").eq("key", "contact.phone").maybeSingle();
    const fromAdmin = parseHelpline(data?.value);
    if (fromAdmin) return fromAdmin;
  } catch (e) {
    console.error("[helpline] could not read the admin setting", e instanceof Error ? e.message : e);
  }
  return parseHelpline(process.env.HELPLINE_PHONE);
}
