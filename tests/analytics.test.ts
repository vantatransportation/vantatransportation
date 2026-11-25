import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { completedByMonth, driverTable, lastMonths, monthKey, paymentSummary, ratingTrend, upcomingRides } from "../src/lib/analytics.ts";

const NY = "America/New_York";

test("months are bucketed in the business time zone, including month ends and daylight-saving changes", () => {
  assert.equal(monthKey("2026-12-01T03:30:00Z", NY), "2026-11");   // 10:30 PM on Nov 30 in New York is still November
  assert.equal(monthKey("2026-12-01T05:00:00Z", NY), "2026-12");   // midnight Dec 1 local
  assert.equal(monthKey("2026-03-08T06:59:00Z", NY), "2026-03");   // just before the March clock change
  assert.equal(monthKey("2026-11-01T04:30:00Z", NY), "2026-11");   // 12:30 AM on the DST-end day
  assert.deepEqual(lastMonths(3, Date.parse("2026-01-15T12:00:00Z"), NY), ["2025-11", "2025-12", "2026-01"]);  // crosses a year
  assert.equal(lastMonths(12, Date.parse("2026-11-25T12:00:00Z"), NY).length, 12);
});

test("completed and upcoming rides count only real bookings in the right states", () => {
  const months = ["2026-10", "2026-11", "2026-12"];
  const b = [
    { status: "completed", pickup_at: "2026-10-31T15:00:00Z" }, { status: "completed", pickup_at: "2026-11-01T03:00:00Z" }, // second is Oct 31 11 PM NY
    { status: "completed", pickup_at: "2026-11-20T10:00:00Z" }, { status: "cancelled", pickup_at: "2026-11-20T10:00:00Z" }, { status: "no_show", pickup_at: "2026-11-21T10:00:00Z" },
    { status: "completed", pickup_at: "2025-01-01T10:00:00Z" },                                                    // outside the window
  ];
  assert.deepEqual(completedByMonth(b, months, NY).map((c) => c.value), [2, 1, 0]);                              // no invented values
  const now = Date.parse("2026-12-01T12:00:00Z");
  const up = upcomingRides([
    { status: "confirmed", pickup_at: "2026-12-03T12:00:00Z" }, { status: "assigned", pickup_at: "2026-12-20T12:00:00Z" }, { status: "getting_ready", pickup_at: "2026-12-02T12:00:00Z" },
    { status: "cancelled", pickup_at: "2026-12-02T12:00:00Z" }, { status: "completed", pickup_at: "2026-12-02T12:00:00Z" }, { status: "confirmed", pickup_at: "2026-11-30T12:00:00Z" },
  ], now);
  assert.deepEqual(up, { total: 3, next7Days: 2 });
});

test("driver table and rating trend: ratings and points stay separate, gaps are not zeros", () => {
  const drivers = [{ id: "a", full_name: "Ann", performance_points: 90 }, { id: "b", full_name: "Bo", performance_points: 40 }, { id: "c", full_name: "Cy", performance_points: null, is_active: false }];
  const ratings = [{ driver_id: "a", stars: 5, created_at: "2026-11-02T10:00:00Z" }, { driver_id: "a", stars: 4, created_at: "2026-11-03T10:00:00Z" }, { driver_id: "b", stars: 2, created_at: "2026-09-03T10:00:00Z" }];
  const t = driverTable(drivers, ratings, [{ status: "completed", pickup_at: "x", driver_id: "a" }, { status: "completed", pickup_at: "x", driver_id: "a" }, { status: "cancelled", pickup_at: "x", driver_id: "a" }]);
  assert.deepEqual(t.map((d) => [d.name, d.avgStars, d.reviews, d.points, d.completed]), [["Ann", 4.5, 2, 90, 2], ["Bo", 2, 1, 40, 0], ["Cy", null, 0, null, 0]]);
  assert.equal(t[2]!.active, false);
  const tr = ratingTrend(ratings, ["2026-09", "2026-10", "2026-11"], NY);
  assert.deepEqual(tr.map((x) => [x.avg, x.count]), [[2, 1], [null, 0], [4.5, 2]]);                              // October has no data, not zero
});

test("payment summary: success, failure and open states, held money, and a success rate that is null without attempts", () => {
  const P = (status: string, amount_cents = 10000) => ({ status, amount_cents, provider: "stripe", created_at: "2026-11-01T00:00:00Z" });
  const s = paymentSummary([P("paid"), P("paid"), P("partially_refunded", 5000), P("refunded"), P("failed"), P("capture_failed"), P("authorization_expired"), P("authorized", 20000), P("pending"), P("review")]);
  assert.equal(s.succeeded, 4); assert.equal(s.failed, 3); assert.equal(s.open, 2); assert.equal(s.review, 1);
  assert.equal(s.collectedCents, 25000); assert.equal(s.heldCents, 20000);                                       // a hold is not collected money
  assert.equal(s.successRate, 57.1);
  assert.equal(paymentSummary([]).successRate, null); assert.equal(paymentSummary([P("pending")]).successRate, null);
});

test("the analytics page is admin-only, read-only, uses no new dependency and selects no customer contact data", () => {
  const page = readFileSync("src/app/admin/(panel)/analytics/page.tsx", "utf8");
  assert.match(page, /adminPage\(\)/);
  assert.ok(!/\.(insert|update|delete|upsert)\(/.test(page));
  assert.ok(!/from\("customers"\)|select\("[^"]*(email|phone|name)[^"]*"\)/.test(page.replace(/full_name/g, "")), "no customer contact data is read"); // drivers.full_name is the only name selected
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(!("chart.js" in { ...pkg.dependencies, ...pkg.devDependencies }));
  assert.match(readFileSync("src/components/admin/AdminSidebar.tsx", "utf8"), /\/admin\/analytics/);
});
