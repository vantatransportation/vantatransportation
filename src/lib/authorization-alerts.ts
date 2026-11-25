/** Pure helpers for the admin card-authorization alerts (no server imports, so they are unit-tested directly). */
export type ExpiryLevel = "expired" | "within_24h" | "within_48h" | "ok" | "unknown";

/** How close a card hold is to lapsing. `captureBefore` comes from Stripe (it varies by card network and payment method). */
export function expiryLevel(captureBefore: string | null | undefined, nowMs: number): ExpiryLevel {
  const t = captureBefore ? new Date(captureBefore).getTime() : NaN;
  if (!Number.isFinite(t)) return "unknown";
  const left = t - nowMs;
  return left <= 0 ? "expired" : left <= 24 * 3600_000 ? "within_24h" : left <= 48 * 3600_000 ? "within_48h" : "ok";
}
