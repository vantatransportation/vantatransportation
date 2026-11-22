/**
 * Which origin to put in links that leave this site (here: the Supabase invitation `redirectTo`).
 *
 * NEXT_PUBLIC_SITE_URL is normally right, but it is inlined at BUILD time and `.env.example` defaults it to
 * http://localhost:3000. A production build made with that value would email drivers a link to localhost, which opens
 * nothing on their phone. So a loopback configured value is ignored when the request itself came from a real domain.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

export function parseOrigin(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

export const isLoopback = (u: URL) => LOOPBACK.has(u.hostname) || u.hostname.endsWith(".localhost");

/** The origin the browser used for this request. Admin routes have already passed the same-origin check. */
export function requestOrigin(request: Request): URL | null {
  const h = request.headers;
  const fromOrigin = parseOrigin(h.get("origin"));
  if (fromOrigin) return fromOrigin;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return parseOrigin(new URL(request.url).origin);
  const proto = (h.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "")).split(",")[0].trim();
  return parseOrigin(`${proto}://${host.split(",")[0].trim()}`);
}

export interface ResolvedOrigin { origin: string; source: "env" | "request" }

export function resolveSiteOrigin(request: Request, configured: string | undefined = process.env.NEXT_PUBLIC_SITE_URL): ResolvedOrigin | null {
  const env = parseOrigin(configured);
  const req = requestOrigin(request);
  if (env && (!isLoopback(env) || !req || isLoopback(req))) return { origin: env.origin, source: "env" };
  if (req) return { origin: req.origin, source: "request" };
  return env ? { origin: env.origin, source: "env" } : null;
}
