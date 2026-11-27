import { json } from "@/lib/http";
import { getAdminClient } from "@/lib/supabase/admin";
import { finalizeCharge } from "@/lib/saved-card";
import { customerRequest, failure } from "@/lib/customer-request";

export const runtime = "nodejs";

/** After the bank's authentication (or a return from it): re-check the payment with Stripe. Only Stripe's verified result can mark it paid. */
export async function POST(request: Request) {
  const g = await customerRequest(request, "confirmfinal", 60);
  if (g instanceof Response) return g;
  const db = getAdminClient();
  if (!db) return json({ error: "Card payment is not available right now." }, 503);
  const r = await finalizeCharge(db, g.cred, g.siteUrl);
  if (!r.ok) return failure(request, r);
  return json(r.state === "requires_action" ? { ok: true, state: r.state, clientSecret: r.clientSecret } : r.state === "processing" ? { ok: true, state: r.state, message: r.message } : { ok: true, state: r.state });
}
