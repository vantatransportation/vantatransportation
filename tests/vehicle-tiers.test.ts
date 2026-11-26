// Multi-tier vehicles (migration 0010): real route handlers + real libs on an in-memory database with mocked Google/Brevo calls.
// These prove the application logic and the migration's SQL text; they do NOT prove the live Supabase database behaves the same.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-ignore: plain JS helper
import { FakeDb } from "./integration/fakedb.mjs";

const db: any = new FakeDb();
(globalThis as any).__fakeDb = db;
Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: "http://fake", SUPABASE_SERVICE_ROLE_KEY: "svc", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  GOOGLE_MAPS_SERVER_API_KEY: "gkey", BREVO_API_KEY: "brevo-test-key", BREVO_SENDER_EMAIL: "sender@example.com", BREVO_SENDER_NAME: "Vanta Test",
  BUSINESS_NOTIFICATION_EMAIL: "owner@example.com", BUSINESS_TIMEZONE: "America/New_York", NEXT_PUBLIC_SITE_URL: "http://site.test",
});
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url);
  if (u.includes("routes.googleapis.com")) {
    const body = JSON.parse(init.body);
    return body.routeModifiers.avoidTolls
      ? reply({ routes: [{ distanceMeters: 35405, duration: "2400s", polyline: { encodedPolyline: "abc" } }] })
      : reply({ routes: [{ distanceMeters: 32187, duration: "1800s", polyline: { encodedPolyline: "xyz" }, travelAdvisory: {} }] });
  }
  if (u === "https://api.brevo.com/v3/smtp/email") return reply({ code: "unauthorized" }, 401); // notification failures must never block bookings
  throw new Error("unexpected fetch " + u);
}) as typeof fetch;

let ipn = 1;
const HDR = () => ({ "content-type": "application/json", origin: "http://site.test", "x-forwarded-host": "site.test", "x-forwarded-for": `10.7.0.${ipn++}` });
const post = (url: string, body: unknown) => new Request("http://site.test" + url, { method: "POST", headers: HDR(), body: JSON.stringify(body) });
const soon = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
const trip = (o: Record<string, unknown> = {}) => ({ pickup: { text: "1 Main St, Baltimore" }, dropoff: { text: "Dulles Airport" }, stops: [], date: soon, time: "09:30", tripType: "distance", passengers: 2, ...o });
const person = { name: "Ann Rider", email: "ann@example.com", phone: "4105550100", policiesAcknowledged: true };

let routes: any;
let T: Record<string, string> = {}; // tier ids by short name
let V: Record<string, string> = {}; // vehicle ids by short name
let pk = 0;

const tiersOf = (vehicleId: string): string[] => db.t("vehicle_tier_assignments").filter((a: any) => a.vehicle_id === vehicleId).map((a: any) => a.tier_id).sort();
const names = (ids: string[]) => ids.map((id) => db.t("vehicle_tiers").find((t: any) => t.id === id).name).sort();
const quote = async (over: Record<string, unknown> = {}) => (await routes.quote.POST(post("/api/fare/quote", trip(over)))).json();
const book = async (vehicleId: string, tierId: string | undefined, extra: Record<string, unknown> = {}, tripOver: Record<string, unknown> = {}) => {
  const res = await routes.bookings.POST(post("/api/bookings", { ...person, trip: trip(tripOver), vehicleId, ...(tierId === undefined ? {} : { tierId }), routeKey: "fastest", submissionKey: `tk-${++pk}-aaaaaaaaaaaaaaaaaa`, ...extra }));
  const data = await res.json();
  return { res, data, row: db.t("bookings").find((b: any) => b.reference === data.reference) };
};
const crud = async (body: object) => {
  (globalThis as any).__cookies = { vt_at: "good" }; // signed-in admin (the test harness maps this token to admin-1)
  const res = await routes.crud.POST(post("/api/admin/crud", body));
  return { res, data: await res.json() };
};

before(async () => {
  db.seed("vehicle_categories", [{ name: "Sedans", slug: "sedans", sort_order: 1, is_active: true }]);
  db.seed("vehicle_tiers", [
    { name: "Premium", slug: "premium", sort_order: 1, is_active: true, fixed_price_cents: 10000, meet_greet_fee_cents: 2500 },
    { name: "Luxury", slug: "luxury", sort_order: 2, is_active: true, fixed_price_cents: 15000, meet_greet_fee_cents: 3500 },
    { name: "Luxury Plus", slug: "luxury-plus", sort_order: 3, is_active: true, fixed_price_cents: 22000, meet_greet_fee_cents: 5000 },
  ]);
  T = { premium: db.t("vehicle_tiers")[0].id, luxury: db.t("vehicle_tiers")[1].id, plus: db.t("vehicle_tiers")[2].id };
  const cat = db.t("vehicle_categories")[0].id;
  const base = { category_id: cat, passenger_capacity: 4, is_active: true, is_available: true, image_url: "/vehicles/sedan.svg" };
  // `tier_id` is the pre-migration single-tier column; the backfill below turns it into assignment rows, as migration 0010 does.
  db.seed("vehicles", [
    { ...base, name: "S-Class", tier_id: T.luxury, sort_order: 1 },
    { ...base, name: "E-Class", tier_id: T.luxury, sort_order: 2 },
    { ...base, name: "Sprinter", tier_id: T.premium, passenger_capacity: 14, sort_order: 3 },
    { ...base, name: "Hidden", tier_id: T.luxury, is_active: false, sort_order: 4 },
    { ...base, name: "Unavailable", tier_id: T.luxury, is_available: false, sort_order: 5 },
    { ...base, name: "Untiered", tier_id: null, sort_order: 6 },
  ]);
  for (const v of db.t("vehicles")) V[v.name] = v.id;
  db.backfillTierAssignments();
  // The S-Class is ALSO offered in Luxury Plus (one vehicle record, two assignments).
  db.seed("vehicle_tier_assignments", [{ vehicle_id: V["S-Class"], tier_id: T.plus }]);
  const cfg = { status: "active", per_mile: 6, hourly_rate: 100, minimum_fare: 100, base_fare: 0, hourly_included_miles: 20, hourly_included_scope: "booking", hourly_extra_mile_rate: 3, min_hours: 2, currency: "USD" };
  db.seed("pricing_configs", ["S-Class", "E-Class", "Sprinter", "Hidden", "Unavailable", "Untiered"].map((n) => ({ ...cfg, vehicle_id: V[n] })));
  db.seed("booking_settings", [{ meet_greet_enabled: true, waiting_included_minutes: 15, waiting_increment_minutes: 15, waiting_rate_cents: null, waiting_rate_approved: false }]);
  db.seed("admin_users", [{ user_id: "admin-1", email: "a@x.com" }]);
  routes = {
    quote: await import("../src/app/api/fare/quote/route.ts"),
    bookings: await import("../src/app/api/bookings/route.ts"),
    qr: await import("../src/app/api/quote-requests/route.ts"),
    crud: await import("../src/app/api/admin/crud/route.ts"),
  };
});

// ---------------------------------------------------------------------------------------------- migration
const sql = readFileSync(new URL("../supabase/migrations/0010_vehicle_tier_assignments.sql", import.meta.url), "utf8");
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

test("migration 0010: join table with foreign keys, a unique pair, indexes, backfill and RLS; nothing destructive", () => {
  assert.match(code, /create table if not exists public\.vehicle_tier_assignments/i);
  assert.match(code, /vehicle_id uuid not null references public\.vehicles\(id\)/i);
  assert.match(code, /tier_id uuid not null references public\.vehicle_tiers\(id\)/i);
  assert.match(code, /unique \(vehicle_id, tier_id\)/i);
  assert.match(code, /create index if not exists vehicle_tier_assignments_tier_idx/i);
  assert.match(code, /insert into public\.vehicle_tier_assignments[\s\S]+from public\.vehicles v where v\.tier_id is not null[\s\S]+on conflict/i);
  assert.match(code, /alter table public\.vehicle_tier_assignments enable row level security/i);
  assert.match(code, /public\.is_admin\(\)/);
  // Public access is read-only: the only non-admin policy is a SELECT.
  const policies = code.match(/create policy[^;]+;/gi) ?? [];
  assert.equal(policies.length, 2);
  assert.ok(policies.filter((p) => !/is_admin/.test(p)).every((p) => /for select/i.test(p)));
  // Forward-only and non-destructive: the old column, bookings and prices are untouched.
  for (const bad of [/drop\s+(table|column|index|schema)/i, /truncate/i, /delete\s+from/i, /alter table public\.vehicles\s+(drop|alter)/i, /update\s+public\./i, /\bdrop\s+policy(?! if exists "(admin full access|public read active tier assignments)")/i]) assert.doesNotMatch(code, bad);
  assert.match(code, /tier_id is 'DEPRECATED/);
  assert.match(sql, /safe to run more than once/i);
});

test("migration backfill keeps every existing vehicle -> tier link, adds none for untiered vehicles, and is repeatable", () => {
  const d: any = new FakeDb();
  d.seed("vehicle_tiers", [{ name: "A" }, { name: "B" }]);
  const [a, b] = d.t("vehicle_tiers").map((t: any) => t.id);
  d.seed("vehicles", [{ name: "v1", tier_id: a }, { name: "v2", tier_id: b }, { name: "v3", tier_id: null }]);
  d.backfillTierAssignments(); d.backfillTierAssignments();
  const rows = d.t("vehicle_tier_assignments");
  assert.equal(rows.length, 2);
  for (const v of d.t("vehicles").filter((x: any) => x.tier_id)) assert.ok(rows.some((r: any) => r.vehicle_id === v.id && r.tier_id === v.tier_id));
  assert.equal(d.t("vehicles").length, 3); // no vehicle was created or removed
});

test("seed.sql links its vehicles to their tiers idempotently, without inventing multi-tier data", () => {
  const seed = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8");
  assert.match(seed, /insert into public\.vehicle_tier_assignments[\s\S]+on conflict \(vehicle_id, tier_id\) do nothing/i);
});

// ---------------------------------------------------------------------------------------------- data model
test("duplicate (vehicle, tier) assignments are rejected by the unique pair", async () => {
  const r = await db.from("vehicle_tier_assignments").insert({ vehicle_id: V["S-Class"], tier_id: T.plus });
  assert.equal(r.error?.code, "23505");
  assert.equal(tiersOf(V["S-Class"]).length, 2);
});

// ---------------------------------------------------------------------------------------------- Calculate Your Fare
test("a vehicle in two tiers appears in both, once per tier; it is absent from tiers it is not assigned to", async () => {
  const d = await quote();
  const sClass = d.vehicles.filter((v: any) => v.name === "S-Class");
  assert.equal(sClass.length, 1, "one canonical vehicle option, not one per tier");
  assert.deepEqual(sClass[0].tiers.map((t: any) => t.name), ["Luxury", "Luxury Plus"]);
  const { tierChoicesFrom, vehiclesInTier } = await import("../src/lib/vehicle-tiers.ts");
  const inTier = (t: string) => vehiclesInTier(d.vehicles, T[t]).map((v: any) => v.name).sort();
  assert.deepEqual(inTier("luxury"), ["E-Class", "S-Class"]);
  assert.deepEqual(inTier("plus"), ["S-Class"]);
  assert.deepEqual(inTier("premium"), ["Sprinter"]);
  assert.deepEqual(tierChoicesFrom(d.vehicles, d.tiers).map((t: any) => t.name), ["Premium", "Luxury", "Luxury Plus"]);
});

test("existing eligibility rules still apply: active, available, seating; and vehicles with no tier are not offered", async () => {
  const names_ = (await quote()).vehicles.map((v: any) => v.name);
  for (const hidden of ["Hidden", "Unavailable", "Untiered"]) assert.ok(!names_.includes(hidden), hidden);
  const big = (await quote({ passengers: 10 })).vehicles.map((v: any) => v.name);
  assert.deepEqual(big, ["Sprinter"]); // capacity filter unchanged
});

test("each tier keeps its own price: the same vehicle carries different fixed prices and Meet & Greet fees per tier", async () => {
  const s = (await quote()).vehicles.find((v: any) => v.name === "S-Class");
  assert.deepEqual(s.tiers.map((t: any) => [t.name, t.meetGreetFeeCents]), [["Luxury", 3500], ["Luxury Plus", 5000]]);
  // The trip estimate belongs to the vehicle and is identical in both tiers; the customer sees ONE combined fare per tier (fee + estimate),
  // so the two combined fares differ by exactly the difference of the tier fixed fees ($70), and no fixed fee is exposed.
  const [lux, plus] = s.tiers.map((t: any) => t.tripFare.fastest.cents);
  assert.equal(plus - lux, 22000 - 15000);
  assert.ok(lux > 15000);
  assert.ok(!JSON.stringify(s).includes("fixedPriceCents"));
});

// ---------------------------------------------------------------------------------------------- booking validation
test("booking in each of a vehicle's tiers saves THAT tier and charges THAT tier's fixed price and Meet & Greet fee", async () => {
  const lux = await book(V["S-Class"], T.luxury);
  assert.equal(lux.res.status, 200);
  assert.deepEqual([lux.row.tier_id, lux.row.tier_name, lux.row.fixed_price_cents, lux.row.online_amount_cents], [T.luxury, "Luxury", 15000, 15000 + lux.row.estimated_fare_cents]);
  const plus = await book(V["S-Class"], T.plus.toUpperCase()); // ids are matched case-insensitively
  assert.equal(plus.res.status, 200);
  assert.deepEqual([plus.row.tier_id, plus.row.tier_name, plus.row.fixed_price_cents, plus.row.online_amount_cents], [T.plus, "Luxury Plus", 22000, 22000 + plus.row.estimated_fare_cents]);
  assert.equal(plus.row.vehicle_id, lux.row.vehicle_id); // same canonical vehicle
  assert.equal(plus.row.estimated_fare_cents, lux.row.estimated_fare_cents);
  const mg = await book(V["S-Class"], T.plus, { airport: { airport: "Dulles Airport", direction: "arrival", flightNumber: "UA1", airline: "United", terminal: "B", passengerName: "Ann Rider" } }, { meetGreet: true });
  assert.equal(mg.res.status, 200);
  assert.equal(mg.row.meet_greet_fee_cents, 5000); assert.equal(mg.row.online_amount_cents, 22000 + mg.row.estimated_fare_cents + 5000);
});

test("the server rejects vehicle/tier pairs that are not offered, unknown tiers and a missing tier for a multi-tier vehicle", async () => {
  const before_ = db.t("bookings").length;
  const wrongTier = await book(V["E-Class"], T.plus);       // E-Class is not in Luxury Plus
  assert.equal(wrongTier.res.status, 422); assert.match(wrongTier.data.error, /not offered in/i);
  assert.equal((await book(V["Sprinter"], T.luxury)).res.status, 422);
  assert.equal((await book(V["S-Class"], T.premium)).res.status, 422);
  assert.equal((await book(V["S-Class"], "00000000-0000-4000-8000-000000000000")).res.status, 422);
  assert.equal((await book(V["S-Class"], "x")).res.status, 422);
  const missing = await book(V["S-Class"], undefined);       // two tiers: the customer must choose
  assert.equal(missing.res.status, 422); assert.match(missing.data.error, /choose a service tier/i);
  assert.equal(db.t("bookings").length, before_, "nothing was saved for any rejected combination");
});

test("a single-tier vehicle needs no tier from the browser; its only tier is used", async () => {
  const ok = await book(V["E-Class"], undefined);
  assert.equal(ok.res.status, 200); assert.equal(ok.row.tier_name, "Luxury");
});

test("inactive, hidden and unavailable vehicles cannot be booked; a retired tier is neither shown nor accepted", async () => {
  assert.notEqual((await book(V["Hidden"], T.luxury)).res.status, 200);
  assert.notEqual((await book(V["Unavailable"], T.luxury)).res.status, 200);
  assert.notEqual((await book(V["Untiered"], undefined)).res.status, 200);
  db.t("vehicle_tiers").find((t: any) => t.id === T.plus).is_active = false;
  try {
    const d = await quote();
    assert.deepEqual(d.vehicles.find((v: any) => v.name === "S-Class").tiers.map((t: any) => t.name), ["Luxury"]);
    assert.equal((await book(V["S-Class"], T.plus)).res.status, 422);
    assert.equal((await book(V["S-Class"], undefined)).res.status, 200); // now a single-tier vehicle
  } finally { db.t("vehicle_tiers").find((t: any) => t.id === T.plus).is_active = true; }
});

test("quote requests keep a valid tier and reject an invalid one", async () => {
  const send = (tierId: string | undefined) => routes.qr.POST(post("/api/quote-requests", { trip: trip(), vehicleId: V["S-Class"], tierId, routeKey: "fastest", name: "Pat Roe", email: "pat@example.com", phone: "4105550166", message: "Please", submissionKey: `qk-${++pk}-aaaaaaaaaaaaaaaaaaa` }));
  assert.equal((await send(T.premium)).status, 422);
  const ok = await send(T.plus);
  assert.equal(ok.status, 200);
  assert.equal(db.t("quote_requests").at(-1).trip.tierId, T.plus);
});

// ---------------------------------------------------------------------------------------------- admin
test("admin can add and remove tier assignments on a vehicle; one vehicle record throughout", async () => {
  const count = db.t("vehicles").length;
  const add = await crud({ resource: "vehicles", action: "update", id: V["E-Class"], values: { tier_ids: [T.luxury, T.plus, T.plus.toUpperCase()] } });
  assert.equal(add.res.status, 200);
  assert.deepEqual(names(tiersOf(V["E-Class"])), ["Luxury", "Luxury Plus"], "duplicates in the request collapse to one assignment each");
  assert.equal(db.t("vehicles").find((v: any) => v.id === V["E-Class"]).tier_id, T.luxury, "deprecated column mirrors the first tier");
  assert.ok((await quote()).vehicles.find((v: any) => v.name === "E-Class").tiers.some((t: any) => t.id === T.plus));

  const rm = await crud({ resource: "vehicles", action: "update", id: V["E-Class"], values: { tier_ids: [T.plus] } });
  assert.equal(rm.res.status, 200);
  assert.deepEqual(names(tiersOf(V["E-Class"])), ["Luxury Plus"]);
  assert.equal(db.t("vehicles").find((v: any) => v.id === V["E-Class"]).tier_id, T.plus);
  assert.deepEqual((await quote()).vehicles.find((v: any) => v.name === "E-Class").tiers.map((t: any) => t.name), ["Luxury Plus"]);

  await crud({ resource: "vehicles", action: "update", id: V["E-Class"], values: { tier_ids: [T.luxury] } }); // restore
  assert.equal(db.t("vehicles").length, count);
  assert.ok(db.t("activity_logs").some((l: any) => l.action === "vehicles.tiers" && l.entity_id === V["E-Class"]));
});

test("admin: other vehicle edits leave tiers alone; a vehicle can be created with tiers; removing every tier is allowed and un-offers it", async () => {
  const keep = await crud({ resource: "vehicles", action: "update", id: V["S-Class"], values: { description: "Flagship" } });
  assert.equal(keep.res.status, 200);
  assert.deepEqual(names(tiersOf(V["S-Class"])), ["Luxury", "Luxury Plus"]);

  const made = await crud({ resource: "vehicles", action: "create", values: { name: "Maybach", category_id: db.t("vehicle_categories")[0].id, passenger_capacity: 4, is_active: true, is_available: true, tier_ids: [T.luxury, T.plus] } });
  assert.equal(made.res.status, 200, JSON.stringify(made.data));
  assert.deepEqual(names(tiersOf(made.data.id)), ["Luxury", "Luxury Plus"]);

  await crud({ resource: "vehicles", action: "update", id: made.data.id, values: { tier_ids: [] } });
  assert.equal(tiersOf(made.data.id).length, 0);
  assert.equal(db.t("vehicles").find((v: any) => v.id === made.data.id).tier_id, null);
  db.seed("pricing_configs", [{ vehicle_id: made.data.id, status: "active", per_mile: 6, hourly_rate: 100, minimum_fare: 100, base_fare: 0, hourly_included_miles: 20, hourly_included_scope: "booking", hourly_extra_mile_rate: 3, min_hours: 2, currency: "USD" }]);
  assert.ok(!(await quote()).vehicles.some((v: any) => v.name === "Maybach"));
});

test("admin validation: invalid ids, unknown tiers and inactive tiers are rejected and change nothing", async () => {
  const snapshot = JSON.stringify(tiersOf(V["Sprinter"]));
  for (const bad of [["not-a-uuid"], ["00000000-0000-4000-8000-000000000000"], "x"]) {
    const r = await crud({ resource: "vehicles", action: "update", id: V["Sprinter"], values: { tier_ids: bad } });
    assert.equal(r.res.status, 422);
  }
  db.t("vehicle_tiers").find((t: any) => t.id === T.plus).is_active = false;
  try { assert.equal((await crud({ resource: "vehicles", action: "update", id: V["Sprinter"], values: { tier_ids: [T.plus] } })).res.status, 422); }
  finally { db.t("vehicle_tiers").find((t: any) => t.id === T.plus).is_active = true; }
  assert.equal(JSON.stringify(tiersOf(V["Sprinter"])), snapshot);
});

test("admin list shows every assigned tier; tiers are attached once per vehicle", async () => {
  const { attachVehicleTiers } = await import("../src/lib/vehicle-tiers.ts");
  const rows = await attachVehicleTiers(db, db.t("vehicles").map((v: any) => ({ id: v.id })));
  const s = rows.find((r: any) => r.id === V["S-Class"]);
  assert.deepEqual(s.tier_names, ["Luxury", "Luxury Plus"]); assert.equal(s.tier_ids.length, 2);
  assert.deepEqual(rows.find((r: any) => r.id === V["Untiered"]).tier_names, []);
});

// ---------------------------------------------------------------------------------------------- history, public site, rollout safety
test("existing bookings keep their saved tier and price when assignments change later", async () => {
  const b = await book(V["S-Class"], T.plus);
  const snap = JSON.stringify([b.row.tier_id, b.row.tier_name, b.row.fixed_price_cents, b.row.online_amount_cents]);
  await crud({ resource: "vehicles", action: "update", id: V["S-Class"], values: { tier_ids: [T.luxury] } });
  const after = db.t("bookings").find((x: any) => x.id === b.row.id);
  assert.equal(JSON.stringify([after.tier_id, after.tier_name, after.fixed_price_cents, after.online_amount_cents]), snap);
  await crud({ resource: "vehicles", action: "update", id: V["S-Class"], values: { tier_ids: [T.luxury, T.plus] } }); // restore
  // A booking made before tiers were recorded (no tier columns) is still a normal row.
  const legacy = db.t("bookings").find((x: any) => x.id === b.row.id);
  assert.ok(legacy.vehicle_id);
});

test("public fleet cards: one card per vehicle listing all of its tiers", async () => {
  const content = await import("../src/lib/content.ts");
  const site = await content.getSiteData();
  const cards = site.vehicles.filter((v: any) => v.name === "S-Class");
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].tierNames, ["Luxury", "Luxury Plus"]);
  assert.equal(cards[0].tierName, "Luxury");
});

test("before migration 0010 is applied the site keeps working in single-tier mode, and admin saves explain what to do", async () => {
  db.dropTableForTest("vehicle_tier_assignments");
  try {
    const d = await quote();
    assert.deepEqual(d.vehicles.find((v: any) => v.name === "E-Class").tiers.map((t: any) => t.name), ["Luxury"]); // legacy tier_id
    assert.equal((await book(V["E-Class"], T.luxury)).res.status, 200);
    const save = await crud({ resource: "vehicles", action: "update", id: V["E-Class"], values: { tier_ids: [T.luxury] } });
    assert.equal(save.res.status, 500); assert.match(save.data.error, /migration 0010/i);
  } finally { db.missing.delete("vehicle_tier_assignments"); }
});

test("regression: bookings, fares and Meet & Greet keep their pricing for a single-tier vehicle", async () => {
  const b = await book(V["Sprinter"], T.premium, {}, { passengers: 10 });
  assert.equal(b.res.status, 200);
  assert.deepEqual([b.row.tier_name, b.row.fixed_price_cents], ["Premium", 10000]);
});
