import { json } from "@/lib/http";
import { getAdminClient } from "@/lib/supabase/admin";
import { confirmAndCharge } from "@/lib/saved-card";
import { customerRequest, failure } from "@/lib/customer-request";

export const runtime = "nodejs";

/**
 * "Confirm Booking & Authorize Charge". Body: { token | trackingId, consent: true }. The amount is never accepted from the browser: the server
 * verifies approval, the saved card and the authoritative total, then charges the saved card once. The reply says what Stripe reported
 * (paid / processing / requires_action with a client secret for the bank's authentication / failed). A browser reply never marks anything paid.
 */
export async function POST(request: Request) {
  const g = await customerRequest(request, "confirm", 20);
  if (g instanceof Response) return g;
  const db = getAdminClient();
  if (!db) return json({ error: "Card payment is not available right now." }, 503);
  const r = await confirmAndCharge(db, g.cred, g.body.consent === true, g.siteUrl);
  if (!r.ok) return failure(request, r);
  return json(r.state === "requires_action" ? { ok: true, state: r.state, clientSecret: r.clientSecret } : r.state === "processing" ? { ok: true, state: r.state, message: r.message } : { ok: true, state: r.state });
}
