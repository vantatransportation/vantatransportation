import { json, readJson } from "@/lib/http";
import { getAdminClient } from "@/lib/supabase/admin";
import { authTracking } from "@/lib/track-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public tracking lookup. Body: { trackingId }. Returns the customer-safe trip view for that ONE booking. */
export async function POST(request: Request) {
  const body = await readJson(request);
  const db = getAdminClient();
  if (!db) return json({ error: "Tracking is temporarily unavailable. Please try again shortly." }, 503);
  const a = await authTracking(db, request, body?.trackingId);
  if (a instanceof Response) return a;
  return json({ trip: a.view.view }, 200);
}
