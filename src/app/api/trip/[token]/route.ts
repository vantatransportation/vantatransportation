import { json } from "@/lib/http";
import { getAdminClient } from "@/lib/supabase/admin";
import { loadTrip } from "@/lib/trip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Status poll for the customer's private booking page. Unknown or malformed tokens look identical (404). */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const db = getAdminClient();
  if (!db) return json({ error: "Not available." }, 503);
  const t = await loadTrip(db, token);
  if (!t) return json({ error: "Not found." }, 404);
  return json({ trip: t.view }, 200);
}
