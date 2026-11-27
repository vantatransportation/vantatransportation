import { json } from "@/lib/http";
import { getAdminClient } from "@/lib/supabase/admin";
import { startCardSetup } from "@/lib/saved-card";
import { customerRequest, failure } from "@/lib/customer-request";

export const runtime = "nodejs";

/**
 * Starts (or resumes) saving the customer's card for THEIR booking. Body: { token | trackingId, consent: true }.
 * Returns the SetupIntent client secret for Stripe Elements. Nothing is charged and no funds are held.
 */
export async function POST(request: Request) {
  const g = await customerRequest(request, "cardsetup", 20);
  if (g instanceof Response) return g;
  const db = getAdminClient();
  if (!db) return json({ error: "Card payment is not available right now." }, 503);
  const r = await startCardSetup(db, g.cred, g.body.consent === true);
  return r.ok ? json({ ok: true, clientSecret: r.clientSecret, publishableKey: r.publishableKey, currency: r.currency }) : failure(request, r);
}
