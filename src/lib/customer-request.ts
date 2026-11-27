import "server-only";
import { clientIp, json, readJson, sameOrigin } from "@/lib/http";
import { rateLimit, rateLimitPeek, rateLimitRecord } from "@/lib/rate-limit";
import { credentialFrom, type CustomerCred, type Fail } from "@/lib/saved-card";
import { siteBase } from "@/lib/tracking-url";

/**
 * Shared guard for the customer's card and confirmation endpoints. The browser supplies only a credential for ITS booking (the private booking
 * token, or the tracking ID) and, where needed, a consent flag. Never an amount, a status or a booking id.
 */
export async function customerRequest(request: Request, bucket: string, limit: number): Promise<{ cred: CustomerCred; body: Record<string, unknown>; siteUrl: string } | Response> {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  const ip = clientIp(request);
  if (!rateLimit(`${bucket}:${ip}`, limit, 10 * 60_000)) return json({ error: "Too many attempts. Please wait a few minutes." }, 429);
  if (!rateLimitPeek(`cust-miss:${ip}`, 10, 10 * 60_000)) return json({ error: "Too many attempts. Please wait a few minutes." }, 429);
  const body = await readJson(request);
  const cred = credentialFrom(body);
  if (!cred || !body) { rateLimitRecord(`cust-miss:${ip}`, 10 * 60_000); return json({ error: "We could not find that booking." }, 404); }
  const siteUrl = siteBase() ?? new URL(request.headers.get("origin")!).origin; // sameOrigin() above guarantees a valid Origin for this host
  return { cred, body, siteUrl };
}

/** A failed result: unknown bookings count against the guessing budget and look identical to every other miss. */
export function failure(request: Request, f: Fail): Response {
  if (f.status === 404) rateLimitRecord(`cust-miss:${clientIp(request)}`, 10 * 60_000);
  return json({ error: f.error, code: f.code }, f.status);
}
