/**
 * Minimal in-memory rate limiter. It is per server instance, so on serverless
 * platforms it only slows down casual abuse. For stronger protection add an
 * edge/WAF rule or a shared store (e.g. Upstash Redis) behind this same function.
 */
const hits = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
  }
  return true;
}

/** True while `key` is still under `limit` hits in the window. Does NOT count a hit (pair with rateLimitRecord for "count only failures"). */
export function rateLimitPeek(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  return (hits.get(key) ?? []).filter((t) => now - t < windowMs).length < limit;
}
/** Counts one hit against `key` without checking the limit. */
export function rateLimitRecord(key: string, windowMs: number): void {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
}
