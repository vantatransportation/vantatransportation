import "server-only";
import { stripeConfigured } from "@/lib/stripe";
import { paypalConfigured } from "@/lib/paypal";
import type { BookingSettings } from "@/lib/policies";

export type Provider = "stripe" | "paypal";

/**
 * A provider is offered ONLY when it is switched on by the admin AND fully configured on the server,
 * AND online payment itself is enabled. Nothing here ever reports a provider as available "optimistically".
 */
export function availableProviders(settings: BookingSettings): Provider[] {
  if (settings.payment.mode === "disabled") return [];
  const out: Provider[] = [];
  if (settings.stripeEnabled && stripeConfigured()) out.push("stripe");
  if (settings.paypalEnabled && paypalConfigured()) out.push("paypal");
  return out;
}
