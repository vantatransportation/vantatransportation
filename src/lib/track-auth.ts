import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clientIp, json } from "@/lib/http";
import { rateLimit, rateLimitPeek, rateLimitRecord } from "@/lib/rate-limit";
import { loadTrip } from "@/lib/trip";
import { looksLikeBookingReference, normalizeTrackingCode } from "@/lib/tracking";

export const TRACK_HEADER = "x-tracking-id";
const MISS_WINDOW = 10 * 60_000;

/**
 * Resolves a tracking ID to ITS booking, or a ready-made error Response. Guessing protection:
 *  - an unguessable 60-bit ID (the real defence),
 *  - every request counts against a per-IP budget, and failed lookups against a much smaller one,
 *  - unknown, malformed and booking-reference inputs all return the same generic 404, so nothing reveals which bookings exist.
 * The ID travels in a header or JSON body, never in a URL, so it stays out of access logs and Referer headers.
 */
export async function authTracking(db: SupabaseClient, request: Request, rawId: unknown): Promise<{ id: string; view: Awaited<ReturnType<typeof loadTrip>> & object } | Response> {
  const ip = clientIp(request);
  if (!rateLimitPeek(`track-miss:${ip}`, 10, MISS_WINDOW)) return json({ error: "Too many attempts. Please wait a few minutes and try again." }, 429);
  if (!rateLimit(`track:${ip}`, 900, 10 * 60_000)) return json({ error: "Too many requests. Please wait a few minutes." }, 429);
  const code = normalizeTrackingCode(rawId);
  const t = code ? await loadTrip(db, { kind: "code", code }) : null;
  if (!t) {
    rateLimitRecord(`track-miss:${ip}`, MISS_WINDOW);
    return json({ error: "We could not find a booking for that tracking ID.", hint: looksLikeBookingReference(rawId) ? "reference" : undefined }, 404);
  }
  return { id: t.id, view: t };
}
