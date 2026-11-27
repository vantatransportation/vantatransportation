import { json } from "@/lib/http";
import { getAdminClient } from "@/lib/supabase/admin";
import { completeCardSetup } from "@/lib/saved-card";
import { customerRequest, failure } from "@/lib/customer-request";

export const runtime = "nodejs";

/** The browser says card entry finished. The SERVER reads the SetupIntent back from Stripe; only that marks the card as saved. */
export async function POST(request: Request) {
  const g = await customerRequest(request, "cardcomplete", 30);
  if (g instanceof Response) return g;
  const db = getAdminClient();
  if (!db) return json({ error: "Card payment is not available right now." }, 503);
  const r = await completeCardSetup(db, g.cred);
  return r.ok ? json({ ok: true, brand: r.brand, last4: r.last4 }) : failure(request, r);
}
