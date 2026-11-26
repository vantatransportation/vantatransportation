import { json, clientIp, readJson, sameOrigin } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getAdminClient } from "@/lib/supabase/admin";
import { siteBase } from "@/lib/tracking-url";
import { startAuthorizationByToken, validToken } from "@/lib/payments-server";

export const runtime = "nodejs";

const FAIL: Record<string, { status: number; error: string }> = {
  not_found: { status: 404, error: "We could not find that booking." },
  already_authorized: { status: 409, error: "Your card is already authorized for this booking. Nothing more is needed." },
  not_awaiting_review: { status: 409, error: "This booking is no longer waiting for review, so the card step is not available here. Use the secure payment link in your email, or contact us." },
  disabled: { status: 409, error: "Card authorization is not needed for this booking. We will email you a secure payment link if we approve it." },
  stripe_unavailable: { status: 503, error: "Card payment is not available right now. Your booking is saved; we will contact you about payment." },
  no_online_charge: { status: 409, error: "An online amount has not been set for this booking. We will confirm the price and payment with you." },
  nothing_due: { status: 409, error: "There is nothing to pay online for this booking right now." },
  stripe_error: { status: 502, error: "We could not open the secure card page. You have not been charged. Please try again in a moment." },
  db: { status: 500, error: "We could not start the card step. You have not been charged. Please try again." },
};

/**
 * Starts or RESUMES the card-authorization step for one booking. The browser supplies only the booking's private token: the amount and the
 * booking are resolved on the server, an unfinished hosted page is reused, and a booking that already holds a card never gets a second hold.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!rateLimit(`authorize:${clientIp(request)}`, 15, 10 * 60_000)) return json({ error: "Too many attempts. Please wait a few minutes." }, 429);
  const body = await readJson(request);
  if (!validToken(body?.token)) return json({ error: "Invalid link." }, 400);
  const db = getAdminClient();
  if (!db) return json({ error: "Online payment is not available right now." }, 503);
  const site = siteBase() ?? new URL(request.headers.get("origin")!).origin; // sameOrigin() above guarantees a valid Origin for this host
  const r = await startAuthorizationByToken(db, body.token, site);
  if (r.ok) return json({ ok: true, url: r.url });
  const f = FAIL[r.reason] ?? FAIL.db;
  return json({ error: f.error, reason: r.reason }, f.status);
}
