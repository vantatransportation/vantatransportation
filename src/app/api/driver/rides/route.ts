import { json } from "@/lib/http";
import { getDriverForApi } from "@/lib/driver/auth";
import { loadDriverRides } from "@/lib/driver/rides";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in driver's own rides. The driver id comes from the verified session, never from the request. */
export async function GET() {
  const driver = await getDriverForApi();
  if (!driver) return json({ error: "Please sign in again." }, 401);
  const db = getAdminClient();
  if (!db) return json({ error: "Database is not configured." }, 503);
  return json({ rides: await loadDriverRides(db, driver.id), plate: driver.plate });
}
