import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a Stripe webhook signature header ("t=...,v1=...") against the RAW request body.
 * Rejects stale timestamps (replay protection) and uses a constant-time comparison.
 */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): boolean {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find((p) => p[0] === "t")?.[1];
  const sigs = parts.filter((p) => p[0] === "v1").map((p) => p[1]).filter(Boolean);
  if (!t || sigs.length === 0 || !/^\d+$/.test(t)) return false;
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return sigs.some((s) => {
    try {
      const given = Buffer.from(s, "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    } catch {
      return false;
    }
  });
}

/** Builds a valid header. Used by tests (and handy for local webhook debugging). */
export function signStripePayload(rawBody: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): string {
  return `t=${nowSec},v1=${createHmac("sha256", secret).update(`${nowSec}.${rawBody}`).digest("hex")}`;
}
