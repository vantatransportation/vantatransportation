import { json, readJson, sameOrigin } from "@/lib/http";
import { getDriverForApi } from "@/lib/driver/auth";
import { getAdminClient } from "@/lib/supabase/admin";
import { rateCustomer } from "@/lib/ratings";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The assigned driver rates the customer of THEIR OWN completed ride. Stored separately and visible to administrators only. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  const driver = await getDriverForApi();
  if (!driver) return json({ error: "Please sign in again." }, 401);
  const db = getAdminClient();
  if (!db) return json({ error: "Database is not configured." }, 503);
  const body = await readJson(request);
  const id = typeof body?.bookingId === "string" && UUID_RE.test(body.bookingId) ? body.bookingId : null;
  if (!id) return json({ error: "Invalid request." }, 400);
  const r = await rateCustomer(db, driver.id, id, body?.stars, body?.feedback);
  return r.ok ? json({ ok: true }) : json({ error: r.error }, r.status);
}
