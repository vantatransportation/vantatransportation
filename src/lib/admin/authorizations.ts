import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expiryLevel, type ExpiryLevel } from "@/lib/authorization-alerts";

export interface AuthorizationRow {
  paymentId: string; bookingId: string; reference: string; status: string; amountCents: number; currency: string;
  card: string | null; captureBefore: string | null; level: ExpiryLevel; error: string | null;
  customerName: string | null; customerEmail: string | null; customerPhone: string | null; bookingStatus: string | null;
}

/**
 * Card holds that need an administrator's attention: authorized (waiting for approval, soonest expiry first) and the "needs payment" cases
 * (capture failed or hold expired). Read-only, admin pages only. Customer contact details are shown so the admin can follow up.
 */
export async function loadAuthorizations(db: SupabaseClient, nowMs: number = Date.now(), limit = 40): Promise<AuthorizationRow[]> {
  const { data } = await db.from("payments")
    .select("id,booking_id,status,amount_cents,currency,card_brand,card_last4,capture_before,last_error,bookings(reference,status,customers(name,email,phone))")
    .eq("manual_capture", true).in("status", ["authorized", "capture_failed", "authorization_expired"]).limit(limit);
  const rows = ((data ?? []) as Record<string, any>[]).map((p) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const b = Array.isArray(p.bookings) ? p.bookings[0] : p.bookings;
    const c = b ? (Array.isArray(b.customers) ? b.customers[0] : b.customers) : null;
    return {
      paymentId: p.id, bookingId: p.booking_id, reference: b?.reference ?? "", status: p.status, amountCents: p.amount_cents, currency: p.currency ?? "USD",
      card: p.card_last4 ? `${String(p.card_brand ?? "card").toUpperCase()} ending ${p.card_last4}` : null, captureBefore: p.capture_before ?? null,
      level: p.status === "authorized" ? expiryLevel(p.capture_before, nowMs) : ("expired" as ExpiryLevel), error: p.last_error ?? null,
      customerName: c?.name ?? null, customerEmail: c?.email ?? null, customerPhone: c?.phone ?? null, bookingStatus: b?.status ?? null,
    } satisfies AuthorizationRow;
  });
  const rank = (r: AuthorizationRow) => (r.status !== "authorized" ? 0 : r.level === "expired" ? 1 : r.level === "within_24h" ? 2 : r.level === "within_48h" ? 3 : 4);
  return rows.sort((a, b) => rank(a) - rank(b) || String(a.captureBefore ?? "9").localeCompare(String(b.captureBefore ?? "9")));
}
