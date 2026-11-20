import test from "node:test";
import assert from "node:assert/strict";
import { overlapsRushWindow, rushSurcharge, validateRush, parseTip, computeTip, DEFAULT_RUSH } from "../src/lib/pricing/surcharge.ts";
import { canTransition, canApprove, canAssign } from "../src/lib/booking-status.ts";

// America/New_York, 2026-11-19 is EST (UTC-5). 09:00 local = 14:00Z.
const at = (local: string) => new Date(`2026-11-19T${local}:00-05:00`).toISOString();

test("rush hour: pickup inside a window applies the surcharge once, on the fixed fare", () => {
  const r = rushSurcharge(20000, [{ startIso: at("09:00"), durationMinutes: 30 }], DEFAULT_RUSH);
  assert.deepEqual(r, { applies: true, percent: 5, cents: 1000 });
});
test("rush hour: outside windows, no surcharge; window ends are exclusive", () => {
  assert.equal(rushSurcharge(20000, [{ startIso: at("12:00"), durationMinutes: 30 }], DEFAULT_RUSH).cents, 0);
  assert.equal(rushSurcharge(20000, [{ startIso: at("10:00"), durationMinutes: null }], DEFAULT_RUSH).cents, 0);
  assert.equal(rushSurcharge(20000, [{ startIso: at("07:59"), durationMinutes: null }], DEFAULT_RUSH).cents, 0);
  assert.equal(rushSurcharge(20000, [{ startIso: at("08:00"), durationMinutes: null }], DEFAULT_RUSH).cents, 1000);
});
test("rush hour: a journey that starts before and runs into a window overlaps it", () => {
  assert.equal(overlapsRushWindow({ startIso: at("07:30"), durationMinutes: 45 }, DEFAULT_RUSH), true);
  assert.equal(overlapsRushWindow({ startIso: at("07:30"), durationMinutes: 20 }, DEFAULT_RUSH), false);
});
test("rush hour: a journey spanning both windows is charged once, not twice", () => {
  const r = rushSurcharge(20000, [{ startIso: at("09:00"), durationMinutes: 9 * 60 }], DEFAULT_RUSH);
  assert.equal(r.cents, 1000);
});
test("rush hour: round trip with one leg inside a window is charged once", () => {
  const r = rushSurcharge(30000, [{ startIso: at("12:00"), durationMinutes: 30 }, { startIso: at("17:00"), durationMinutes: 30 }], DEFAULT_RUSH);
  assert.equal(r.cents, 1500);
});
test("rush hour: windows crossing midnight and overnight journeys", () => {
  const s = { ...DEFAULT_RUSH, windows: [{ start: "22:00", end: "02:00" }] };
  assert.equal(overlapsRushWindow({ startIso: at("23:30"), durationMinutes: 10 }, s), true);
  assert.equal(overlapsRushWindow({ startIso: at("01:00"), durationMinutes: 10 }, s), true);   // inside the tail of the previous day's window
  assert.equal(overlapsRushWindow({ startIso: at("03:00"), durationMinutes: 10 }, s), false);
  assert.equal(overlapsRushWindow({ startIso: at("20:00"), durationMinutes: 180 }, s), true);   // starts before, runs into it
});
test("rush hour: uses the configured zone, not UTC, and respects DST", () => {
  // 09:00 New York in July (EDT, UTC-4) is 13:00Z and must be inside the 8-10 window.
  assert.equal(overlapsRushWindow({ startIso: "2026-07-15T13:00:00Z", durationMinutes: null }, DEFAULT_RUSH), true);
  assert.equal(overlapsRushWindow({ startIso: "2026-07-15T09:00:00Z", durationMinutes: null }, DEFAULT_RUSH), false); // 05:00 local
});
test("rush hour: disabled, zero percent or no base means no surcharge; settings validated", () => {
  const j = [{ startIso: at("09:00"), durationMinutes: 10 }];
  assert.equal(rushSurcharge(20000, j, { ...DEFAULT_RUSH, enabled: false }).cents, 0);
  assert.equal(rushSurcharge(20000, j, { ...DEFAULT_RUSH, percent: 0 }).cents, 0);
  assert.equal(rushSurcharge(0, j, DEFAULT_RUSH).cents, 0);
  assert.equal(validateRush(DEFAULT_RUSH), null);
  assert.ok(validateRush({ ...DEFAULT_RUSH, percent: -1 }));
  assert.ok(validateRush({ ...DEFAULT_RUSH, timeZone: "Not/AZone" }));
  assert.ok(validateRush({ ...DEFAULT_RUSH, windows: [{ start: "8:00", end: "10:00" }] }));
});

test("tips: percentages are on the fixed fare only; none is zero; custom validated", () => {
  assert.equal((computeTip(20000, { kind: "percent", percent: 15 }) as { cents: number }).cents, 3000);
  assert.equal((computeTip(20000, { kind: "percent", percent: 25 }) as { cents: number }).cents, 5000);
  assert.equal((computeTip(20000, { kind: "none" }) as { cents: number }).cents, 0);
  assert.equal(computeTip(20000, { kind: "percent", percent: 17 }).ok, false);
  assert.deepEqual(parseTip({ kind: "custom", dollars: "12.50" }), { kind: "custom", cents: 1250 });
  for (const bad of ["-5", "1e3", "NaN", "5.999", "", "abc"]) assert.equal(parseTip({ kind: "custom", dollars: bad }), null);
  assert.equal(computeTip(20000, { kind: "custom", cents: 99_999_999 }).ok, false);
  assert.equal(parseTip(undefined)?.kind, "none");
  assert.equal(parseTip({ kind: "wat" }), null);
});

test("status: invalid transitions are refused; drivers cannot skip steps or approve", () => {
  assert.equal(canTransition("driver", "assigned", "completed"), false);
  assert.equal(canTransition("driver", "on_the_way", "picked_up"), false);
  assert.equal(canTransition("driver", "arrived", "picked_up"), true);
  assert.equal(canTransition("driver", "picked_up", "completed"), true);
  assert.equal(canTransition("driver", "new_request", "assigned"), false);
  assert.equal(canTransition("driver", "assigned", "cancelled"), false);
  assert.equal(canTransition("customer", "assigned", "cancelled"), false);
  assert.equal(canTransition("admin", "completed", "assigned"), false);
  assert.equal(canTransition("admin", "new_request", "rejected"), true);
  assert.equal(canApprove("new_request"), true);
  assert.equal(canApprove("assigned"), false);
  assert.equal(canAssign("assigned"), true);
  assert.equal(canAssign("picked_up"), false);
});
