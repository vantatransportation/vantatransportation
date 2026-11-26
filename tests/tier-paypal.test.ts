import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onlineCharge, validateTierPricing, INITIAL_MEET_GREET_CENTS, MAX_TIER_AMOUNT_CENTS } from "../src/lib/tier-pricing.ts";
import { centsToDecimal, decimalToCents } from "../src/lib/payments.ts";
import { verifyPayPalOrder } from "../src/lib/paypal-verify.ts";

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
const tier = (fixed: number | null, mg: number | null) => ({ id: "t1", name: "Luxury", fixedPriceCents: fixed, meetGreetFeeCents: mg });

test("online charge = fixed tier fee + trip estimate + Meet & Greet (if selected) + add-ons, each exactly once", () => {
  // Illustrative numbers only ($150 tier fee, $130 trip estimate, $35 fee): nothing here is production configuration.
  const a = onlineCharge(tier(15000, 3500), { meetGreet: true, addonsCents: 0, tripEstimateCents: 13000 });
  assert.ok(a.ok); if (a.ok) assert.deepEqual([a.charge.fixedPriceCents, a.charge.tripEstimateCents, a.charge.meetGreetCents, a.charge.totalCents], [15000, 13000, 3500, 31500]);
  const none = onlineCharge(tier(15000, 3500), { meetGreet: false, addonsCents: 0, tripEstimateCents: 13000 });
  assert.ok(none.ok); if (none.ok) assert.equal(none.charge.totalCents, 28000);                         // deselected: fee removed
  const seats = onlineCharge(tier(15000, 3500), { meetGreet: true, addonsCents: 2000, tripEstimateCents: 13000 });
  if (seats.ok) assert.equal(seats.charge.totalCents, 33500);
  // Recalculating (or switching tier and back) never stacks the fee.
  const again = onlineCharge(tier(15000, 3500), { meetGreet: true, addonsCents: 0, tripEstimateCents: 13000 });
  assert.deepEqual(again, a);
  const other = onlineCharge(tier(10000, 2500), { meetGreet: true, addonsCents: 0, tripEstimateCents: 13000 });
  if (other.ok) assert.equal(other.charge.totalCents, 25500);
});

test("online charge refuses to invent amounts (and never falls back to the tier fee alone)", () => {
  const o = { meetGreet: false, addonsCents: 0, tripEstimateCents: 13000 };
  assert.deepEqual(onlineCharge(tier(null, 3500), o), { ok: false, reason: "price_not_set" });
  assert.deepEqual(onlineCharge(null, o), { ok: false, reason: "tier_missing" });
  assert.deepEqual(onlineCharge(tier(15000, null), { ...o, meetGreet: true }), { ok: false, reason: "meet_greet_unavailable" });
  assert.equal(onlineCharge(tier(15000, null), o).ok, true);
  assert.deepEqual(onlineCharge(tier(15000.5, 3500), o), { ok: false, reason: "invalid" });
  assert.deepEqual(onlineCharge(tier(15000, 3500), { ...o, addonsCents: -1 }), { ok: false, reason: "invalid" });
  assert.deepEqual(onlineCharge(tier(15000, 3500), { ...o, tripEstimateCents: null }), { ok: false, reason: "trip_fare_unavailable" });
  assert.deepEqual(onlineCharge(tier(15000, 3500), { ...o, tripEstimateCents: -5 }), { ok: false, reason: "invalid" });
});

test("tier price validation: positive dollars within a sane ceiling, or blank (not configured)", () => {
  assert.equal(validateTierPricing({ fixed_price_cents: 15000, meet_greet_fee_cents: 3500 }), null);
  assert.equal(validateTierPricing({ fixed_price_cents: null }), null);
  assert.equal(validateTierPricing({ name: "x" }), null);
  for (const v of [0, -1, 12.5, "150", MAX_TIER_AMOUNT_CENTS + 1]) assert.ok(validateTierPricing({ fixed_price_cents: v }), String(v));
  assert.ok(validateTierPricing({ meet_greet_fee_cents: 0 }));
});

test("initial Meet & Greet fees are Premium $25, Luxury $35, Luxury Plus $50 in the seed and migration; fixed prices are never seeded", () => {
  assert.deepEqual(INITIAL_MEET_GREET_CENTS, { premium: 2500, luxury: 3500, "luxury-plus": 5000 });
  for (const f of ["../supabase/seed.sql", "../supabase/migrations/0006_fixed_tier_pricing_paypal.sql"]) {
    const sql = read(f);
    assert.match(sql, /meet_greet_fee_cents = 2500 where slug = 'premium'/);
    assert.match(sql, /meet_greet_fee_cents = 3500 where slug = 'luxury'/);
    assert.match(sql, /meet_greet_fee_cents = 5000 where slug = 'luxury-plus'/);
    assert.ok(!/set fixed_price_cents\s*=\s*\d/i.test(sql), "no fixed price may be fabricated: " + f);
  }
  const mig = read("../supabase/migrations/0006_fixed_tier_pricing_paypal.sql");
  assert.match(mig, /slug not in \('premium', 'luxury', 'luxury-plus'\)/);       // anything else is retired, not deleted
  assert.ok(!/delete from public\.vehicle_tiers/i.test(mig));
});

test("money conversion uses integers: 18500 <-> 185.00, with no rounding surprises", () => {
  assert.equal(centsToDecimal(18500), "185.00"); assert.equal(centsToDecimal(5), "0.05"); assert.equal(centsToDecimal(1999), "19.99"); assert.equal(centsToDecimal(0), "0.00");
  assert.equal(decimalToCents("185.00"), 18500); assert.equal(decimalToCents("19.99"), 1999); assert.equal(decimalToCents("0.1"), 10); assert.equal(decimalToCents("7"), 700);
  for (const bad of ["", "abc", "1.234", "-1", "1e3", null, 5, "12,50"]) assert.equal(decimalToCents(bad as never), null, String(bad));
  assert.throws(() => centsToDecimal(1.5)); assert.throws(() => centsToDecimal(-1));
  for (const c of [1, 99, 100, 101, 123456, 999999]) assert.equal(decimalToCents(centsToDecimal(c)), c);
});

const order = (over: Record<string, unknown> = {}, cap: Record<string, unknown> = {}) => ({
  purchase_units: [{ reference_id: "pay1", custom_id: "bk1", payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "185.00" }, ...cap }] }, ...over }],
});
const exp = { amountCents: 18500, currency: "USD", bookingId: "bk1", paymentId: "pay1" };

test("PayPal verification: amount, currency, order identity and status are all checked against what the server asked for", () => {
  assert.deepEqual(verifyPayPalOrder(order(), exp), { ok: true, state: "completed", captureId: "CAP1" });
  assert.deepEqual(verifyPayPalOrder(order({}, { status: "PENDING" }), exp), { ok: true, state: "pending", captureId: "CAP1" });
  assert.equal(verifyPayPalOrder(order({}, { amount: { currency_code: "USD", value: "1.00" } }), exp).ok, false);
  assert.equal(verifyPayPalOrder(order({}, { amount: { currency_code: "EUR", value: "185.00" } }), exp).ok, false);
  assert.equal(verifyPayPalOrder(order({}, { amount: { currency_code: "USD", value: "185.001" } }), exp).ok, false);
  assert.equal(verifyPayPalOrder(order({ custom_id: "other-booking" }), exp).ok, false);
  assert.equal(verifyPayPalOrder(order({ reference_id: "other-payment" }), exp).ok, false);
  const declined = verifyPayPalOrder(order({}, { status: "DECLINED" }), exp);
  assert.deepEqual([declined.ok, !declined.ok && declined.state], [false, "declined"]);
  assert.equal(verifyPayPalOrder({}, exp).ok, false);
  assert.equal(verifyPayPalOrder(null, exp).ok, false);
});

test("Meet & Greet wording: optional paid service, shown in the calculator, never described as free", () => {
  const calc = read("../src/components/FareCalculator.tsx");
  assert.ok(calc.includes("Airport Meet &amp; Greet — Optional paid service"));
  assert.match(calc, /type="checkbox" checked=\{meetGreet\}/);
  for (const f of ["../src/components/FareCalculator.tsx", "../src/components/BookingForm.tsx", "../src/app/(site)/pay/[token]/page.tsx"]) {
    assert.ok(!/meet\s*(&amp;|&)\s*greet[^<{]{0,60}\bfree\b/i.test(read(f)), f);
  }
  const form = read("../src/components/BookingForm.tsx");
  assert.ok(!/setMeetGreet/.test(form)); // single source of truth: the calculator's choice
  assert.ok(calc.includes("Trip fare") && calc.includes("Your price") && calc.includes("Total") && !calc.includes("Estimated trip fare"));
});

test("navbar: all original destinations kept, theme controls collapsed into a dropdown, keyboard and focus handling present", () => {
  const nav = read("../src/components/SiteHeader.tsx");
  for (const href of ['"/"', '"/about"', '"/rides"', '"/quote"', '"/contact"']) assert.ok(nav.includes(`href=${href}`) || nav.includes(`href: ${href}`), href);
  assert.ok(nav.includes("BOOK A RIDE"));
  for (const needle of ["aria-expanded", "aria-controls", 'e.key === "Escape"', "e.key !== \"Tab\"", "pointerdown", "ArrowDown", "toggle.current?.focus()"]) assert.ok(nav.includes(needle), needle);
  const css = read("../src/app/globals.css");
  assert.ok(css.includes(".nav__actions") && css.includes(".theme-menu__panel"));
  assert.match(css, /\.theme-menu__btn \{ min-height: 44px/);
});
