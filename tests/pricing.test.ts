import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateQuote, type PricingConfig } from "../src/lib/pricing/engine.ts";

const base: PricingConfig = {
  id: "c1",
  vehicleId: "v1",
  status: "active",
  currency: "USD",
  perMile: 5,
  hourlyRate: 100,
  minimumFare: 100,
  baseFare: 0,
  hourlyIncludedMiles: 20,
  hourlyIncludedScope: "booking",
  hourlyExtraMileRate: 3,
  minHours: 2,
  longTripThresholdMiles: null,
  longTripPerMile: null,
  surcharges: [],
};

test("distance fare multiplies miles by the per-mile rate", () => {
  const q = calculateQuote(base, { tripType: "distance", distanceMiles: 30 });
  assert.ok(q.ok);
  assert.equal(q.totalCents, 15000);
  assert.equal(q.minimumApplied, false);
});

test("minimum fare is applied to short trips and shown as its own line", () => {
  const q = calculateQuote(base, { tripType: "distance", distanceMiles: 5 });
  assert.ok(q.ok);
  assert.equal(q.totalCents, 10000);
  assert.equal(q.minimumApplied, true);
  assert.ok(q.lineItems.some((l) => l.code === "minimum" && l.cents === 7500));
});

test("draft pricing is refused for customer quotes but allowed for admin preview", () => {
  const draft = { ...base, status: "draft" as const };
  const refused = calculateQuote(draft, { tripType: "distance", distanceMiles: 30 });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error, "pricing_unpublished");
  const preview = calculateQuote(draft, { tripType: "distance", distanceMiles: 30 }, { allowDraft: true });
  assert.ok(preview.ok);
});

test("hourly booking includes 20 miles; extra miles are charged separately", () => {
  const within = calculateQuote(base, { tripType: "hourly", distanceMiles: 20, hours: 3 });
  assert.ok(within.ok);
  assert.equal(within.totalCents, 30000);
  const over = calculateQuote(base, { tripType: "hourly", distanceMiles: 35, hours: 3 });
  assert.ok(over.ok);
  assert.equal(over.totalCents, 30000 + 15 * 3 * 100);
});

test("hourly bookings respect the minimum hours", () => {
  const q = calculateQuote(base, { tripType: "hourly", distanceMiles: 0, hours: 1 });
  assert.ok(q.ok);
  assert.equal(q.totalCents, 20000);
});

test("per_hour mileage scope multiplies the allowance", () => {
  const cfg = { ...base, hourlyIncludedScope: "per_hour" as const };
  const q = calculateQuote(cfg, { tripType: "hourly", distanceMiles: 60, hours: 3 });
  assert.ok(q.ok);
  assert.equal(q.totalCents, 30000); // 60 miles included over 3 hours
});

test("hourly is rejected when the vehicle has no hourly rate", () => {
  const q = calculateQuote({ ...base, hourlyRate: null }, { tripType: "hourly", distanceMiles: 5, hours: 2 });
  assert.equal(q.ok, false);
});

test("long-trip rule charges miles beyond the threshold at the long-trip rate", () => {
  const cfg = { ...base, longTripThresholdMiles: 100, longTripPerMile: 3.5 };
  const q = calculateQuote(cfg, { tripType: "distance", distanceMiles: 150 });
  assert.ok(q.ok);
  assert.equal(q.totalCents, 100 * 500 + 50 * 350);
});

test("flat and percent surcharges are added; percent uses the fare after minimum", () => {
  const cfg = {
    ...base,
    surcharges: [
      { id: "a", label: "Late night", kind: "flat" as const, amount: 20 },
      { id: "b", label: "Service fee", kind: "percent" as const, amount: 10 },
    ],
  };
  const q = calculateQuote(cfg, { tripType: "distance", distanceMiles: 40 }); // 200
  assert.ok(q.ok);
  assert.equal(q.totalCents, 20000 + 2000 + 2000);
});

test("tolls: estimate included when known, flagged unavailable when not, zero when avoided", () => {
  const known = calculateQuote(base, { tripType: "distance", distanceMiles: 40, tollAmount: 12.5 });
  assert.ok(known.ok);
  assert.equal(known.totalCents, 20000 + 1250);
  assert.equal(known.toll.status, "included");

  const unknown = calculateQuote(base, { tripType: "distance", distanceMiles: 40 });
  assert.ok(unknown.ok);
  assert.equal(unknown.toll.status, "unavailable");
  assert.equal(unknown.totalCents, 20000);

  const avoided = calculateQuote(base, { tripType: "distance", distanceMiles: 40, avoidTolls: true, tollAmount: 12.5 });
  assert.ok(avoided.ok);
  assert.equal(avoided.toll.status, "avoided");
  assert.equal(avoided.totalCents, 20000);
});

test("unapproved discounts are ignored; approved discounts reduce the total but not below zero", () => {
  const pending = calculateQuote(base, {
    tripType: "distance",
    distanceMiles: 40,
    discount: { label: "Promo", kind: "percent", amount: 10, approved: false },
  });
  assert.ok(pending.ok);
  assert.equal(pending.totalCents, 20000);

  const approved = calculateQuote(base, {
    tripType: "distance",
    distanceMiles: 40,
    discount: { label: "Promo", kind: "percent", amount: 10, approved: true },
  });
  assert.ok(approved.ok);
  assert.equal(approved.totalCents, 18000);

  const huge = calculateQuote(base, {
    tripType: "distance",
    distanceMiles: 40,
    discount: { label: "Promo", kind: "flat", amount: 9999, approved: true },
  });
  assert.ok(huge.ok);
  assert.equal(huge.totalCents, 0);
});

test("invalid inputs are rejected", () => {
  for (const distanceMiles of [-1, NaN, Infinity]) {
    assert.equal(calculateQuote(base, { tripType: "distance", distanceMiles }).ok, false);
  }
  assert.equal(calculateQuote(base, { tripType: "distance", distanceMiles: 5, tollAmount: -3 }).ok, false);
});

test("snapshot stores the config used, so later rate changes cannot alter it", () => {
  const q = calculateQuote(base, { tripType: "distance", distanceMiles: 40 });
  assert.ok(q.ok);
  assert.equal(q.snapshot.config.perMile, 5);
  assert.equal(q.snapshot.input.distanceMiles, 40);
});
