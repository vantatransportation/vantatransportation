import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parseRating, resolvePoints, average } from "../src/lib/rating-rules.ts";

const calc = readFileSync("src/components/FareCalculator.tsx", "utf8");

test("tier cards show no price; vehicle cards show the final total", () => {
  const a = calc.indexOf("Service tier</legend>"), b = calc.indexOf("Choose your vehicle</legend>");
  const tierBlock = calc.slice(a, b);
  assert.ok(tierBlock.length > 200);
  assert.ok(!/formatMoney|fixedPriceCents|opt__price|Price to be confirmed/.test(tierBlock), "tier cards must not render any price");
  assert.match(tierBlock, /t\.description/); assert.match(tierBlock, /VehiclePhoto/);
  const vehicleBlock = calc.slice(b, calc.indexOf("</fieldset>", b));
  assert.match(vehicleBlock, /cardTotal/);
  assert.match(vehicleBlock, /fixedPriceCents \+ \(meetGreet \? vt\.meetGreetFeeCents \?\? 0 : 0\) \+ seatFee/); // the same components the server charges
  assert.ok(!/Estimated trip fare|Fixed .* price, charged online/.test(vehicleBlock), "no second price or tier breakdown on vehicle cards");
});

test("the price the server charges is untouched by Phase 2 (fixed tier price is still resolved server-side)", () => {
  const booking = readFileSync("src/lib/fare/booking.ts", "utf8");
  assert.match(booking, /resolveTierChoice/);
  assert.match(booking, /fixed_price_cents|fixedPriceCents/);
});

test("rating and points rules", () => {
  assert.deepEqual(parseRating(5, "  great  "), { ok: true, stars: 5, feedback: "great" });
  assert.deepEqual(parseRating("3", ""), { ok: true, stars: 3, feedback: null });
  for (const bad of [0, 6, 1.5, NaN, null, undefined, "abc", {}]) assert.equal(parseRating(bad, null).ok, false, String(bad));
  assert.equal(parseRating(5, 42).ok, false); assert.equal(parseRating(5, "x".repeat(1001)).ok, false);
  assert.deepEqual(resolvePoints(80, { adjustment: 20 }), { ok: true, previous: 80, next: 100, adjustment: 20 });
  assert.deepEqual(resolvePoints(80, { newPoints: 0 }), { ok: true, previous: 80, next: 0, adjustment: -80 });
  for (const bad of [{ adjustment: 21 }, { adjustment: -81 }, { newPoints: -1 }, { newPoints: 101 }, { adjustment: 0 }, {}, { adjustment: 1, newPoints: 2 }, { adjustment: "x" }]) assert.equal(resolvePoints(80, bad as never).ok, false, JSON.stringify(bad));
  assert.deepEqual(average([5, 4]), { avg: 4.5, count: 2 }); assert.deepEqual(average([]), { avg: null, count: 0 });
});

test("migration 0013 is additive, keeps rating data, and locks the new tables to admins", () => {
  const f = readdirSync("supabase/migrations").filter((x) => x.startsWith("0013"));
  assert.equal(f.length, 1);
  const sql = readFileSync(`supabase/migrations/${f[0]}`, "utf8").toLowerCase();
  assert.ok(!/drop\s+(table|column)|truncate|delete\s+from/.test(sql));
  for (const t of ["driver_ratings", "customer_ratings", "driver_points_history"]) { assert.ok(sql.includes(`create table if not exists public.${t}`), t); assert.ok(sql.includes(`alter table public.${t} enable row level security`), t); }
  assert.match(sql, /booking_id uuid not null unique references public\.bookings/);          // one customer rating per booking, in the database too
  assert.match(sql, /performance_points between 0 and 100/);
  assert.match(sql, /show_rating_to_driver boolean not null default false/); assert.match(sql, /show_points_to_driver boolean not null default false/);
});

test("customer-facing pages never read the admin-only tables", () => {
  for (const file of ["src/lib/trip.ts", "src/app/api/track/route.ts"]) {
    const t = readFileSync(file, "utf8");
    assert.ok(!t.includes("customer_ratings") && !t.includes("driver_points_history") && !t.includes("performance_points"), file);
  }
});

test("admin booking page shows the conversation and the admin chat view is read-only", () => {
  const page = readFileSync("src/app/admin/(panel)/bookings/[id]/page.tsx", "utf8");
  assert.match(page, /BookingConversation/); assert.match(page, /\.eq\("booking_id", id\)/);
  const comp = readFileSync("src/components/admin/BookingConversation.tsx", "utf8");
  assert.ok(!/<textarea|<input|fetch\(/.test(comp));
});
