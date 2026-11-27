import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadTrip, type TripView } from "@/lib/trip";
import { validToken } from "@/lib/payments-core";
import { normalizeTrackingCode } from "@/lib/tracking";

/**
 * What the customer's own booking page shows, reached with the booking's PRIVATE token (never the guessable VT- reference). It is the same
 * customer-safe view as the tracker (loadTrip) plus the tracking ID, which is the customer's own credential. Nothing internal: no database ids,
 * tier fee, admin notes, driver phone numbers or payment-provider references.
 */
export interface ConfirmationView { trip: TripView; trackingCode: string | null; currency: string }

export async function loadConfirmation(db: SupabaseClient, token: unknown): Promise<ConfirmationView | null> {
  if (!validToken(token)) return null;
  const t = await loadTrip(db, { kind: "token", token });
  if (!t) return null;
  const { data: b } = await db.from("bookings").select("tracking_code,currency").eq("id", t.id).maybeSingle();
  return { trip: t.view, trackingCode: normalizeTrackingCode(b?.tracking_code), currency: b?.currency ?? "USD" };
}
