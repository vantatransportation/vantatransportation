/**
 * Customer-facing tracking links. Pure (no server-only imports) so the server, emails and tests share ONE implementation.
 *
 * The link is `<site>/track#id=<TRACKING ID>`. The ID rides in the URL #fragment on purpose: browsers never send a fragment to the
 * server, to access logs or in Referer headers, and the Track page reads it once, loads that one ride and removes it from the address bar.
 * The tracking ID itself is a random 60-bit credential (see tracking.ts), not a guessable booking reference or database id.
 */
import { normalizeTrackingCode } from "@/lib/tracking";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * The configured public site URL as an absolute origin with no trailing slash, or null when it is missing or unusable.
 * In production a link must be HTTPS and must never point at localhost: http:// on a real host is upgraded to https://,
 * and a localhost/missing URL yields null (the email then simply has no link instead of a broken one).
 */
export function siteBase(configured: string | undefined = process.env.NEXT_PUBLIC_SITE_URL, nodeEnv: string | undefined = process.env.NODE_ENV): string | null {
  const raw = (configured ?? "").trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (nodeEnv === "production") {
    if (LOCAL_HOSTS.has(u.hostname)) return null;
    u.protocol = "https:";
  }
  return u.origin;
}

/** Absolute direct link to ONE ride's tracker, or null when the ID is malformed or no usable site URL is configured. */
export function trackingUrl(code: unknown, base: string | null = siteBase()): string | null {
  const id = normalizeTrackingCode(code);
  if (!id || !base) return null;
  return `${base}/track#id=${id}`;
}

/** Same-site relative version for in-app links (confirmation page, receipts). */
export function trackingPath(code: unknown): string | null {
  const id = normalizeTrackingCode(code);
  return id ? `/track#id=${id}` : null;
}
