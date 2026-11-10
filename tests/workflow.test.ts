// End-to-end workflow tests: real route handlers + real libs, with an in-memory database and mocked
// Google and Brevo network calls. These do NOT prove the live integrations work.
import { test, before } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore: plain JS helper
import { FakeDb } from "./integration/fakedb.mjs";
import { signStripePayload } from "../src/lib/stripe-signature.ts";
import { createHash } from "node:crypto";

const db: any = new FakeDb();
(globalThis as any).__fakeDb = db;
Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: "http://fake", SUPABASE_SERVICE_ROLE_KEY: "svc", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  GOOGLE_MAPS_SERVER_API_KEY: "gkey", BREVO_API_KEY: "brevo-test-key", BREVO_SENDER_EMAIL: "sender@example.com", BREVO_SENDER_NAME: "Vanta Test",
  BUSINESS_NOTIFICATION_EMAIL: "owner@example.com", BUSINESS_TIMEZONE: "America/New_York",
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", NEXT_PUBLIC_SITE_URL: "http://site.test",
  NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: "democloud", NEXT_PUBLIC_CLOUDINARY_API_KEY: "123456", CLOUDINARY_API_SECRET: "cloud-secret-xyz",
});

// ---- network mocks -------------------------------------------------------------------------
const net = { tollMode: "unknown" as "unknown" | "known", emailOk: false, calls: [] as { url: string; body: any; headers: any }[], sid: 0 };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url);
  const body = init?.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init?.body;
  net.calls.push({ url: u, body, headers: init?.headers });
  if (u.includes("routes.googleapis.com")) {
    return body.routeModifiers.avoidTolls
      ? reply({ routes: [{ distanceMeters: 35405, duration: "2400s", polyline: { encodedPolyline: "abc" } }] }) // ~22 mi
      : reply({ routes: [{ distanceMeters: 32187, duration: "1800s", polyline: { encodedPolyline: "xyz" }, travelAdvisory: { tollInfo: net.tollMode === "known" ? { estimatedPrice: [{ currencyCode: "USD", units: "4", nanos: 500000000 }] } : {} } }] }); // ~20 mi
  }
  if (u === "https://api.brevo.com/v3/smtp/email") return net.emailOk ? reply({ messageId: "<m1@brevo>" }, 201) : reply({ code: "unauthorized", message: "Key not found" }, 401);
  if (u === "https://api.stripe.com/v1/checkout/sessions") { const id = `cs_test_${++net.sid}`; return reply({ id, url: `https://checkout.stripe.com/c/pay/${id}` }); }
  if (u.startsWith("https://api.stripe.com/v1/checkout/sessions/") && u.endsWith("/expire")) return reply({});
  if (u === "https://api.cloudinary.com/v1_1/democloud/image/destroy") return reply({ result: "ok" });
  throw new Error("unexpected fetch " + u);
}) as typeof fetch;

let ipn = 1;
const HDR = (extra: Record<string, string> = {}) => ({ "content-type": "application/json", origin: "http://site.test", "x-forwarded-host": "site.test", "x-forwarded-for": `10.1.0.${ipn++}`, ...extra });
const post = (url: string, body: unknown, extra?: Record<string, string>) => new Request("http://site.test" + url, { method: "POST", headers: HDR(extra), body: JSON.stringify(body) });
const soon = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
const ack = { policiesAcknowledged: true };
const trip = (o: Record<string, unknown> = {}) => ({ pickup: { text: "1 Main St, Baltimore" }, dropoff: { text: "Dulles Airport" }, stops: [{ text: "Stop St" }], date: soon, time: "09:30", tripType: "distance", passengers: 2, ...o });

let ids: Record<string, string> = {};
let routes: any;

before(async () => {
  db.seed("vehicle_categories", [{ name: "Sedans", sort_order: 1 }]);
  db.seed("vehicle_tiers", [{ name: "Luxury" }]);
  const cat = db.t("vehicle_categories")[0].id, tier = db.t("vehicle_tiers")[0].id;
  db.seed("vehicles", [
    { name: "E-Class", category_id: cat, tier_id: tier, passenger_capacity: 4, is_active: true, is_available: true, sort_order: 1, image_url: "/vehicles/sedan.svg" },
    { name: "Sprinter", category_id: cat, tier_id: tier, passenger_capacity: 14, is_active: true, is_available: true, sort_order: 2, image_url: "/vehicles/van.svg" },
  ]);
  ids = { eclass: db.t("vehicles")[0].id, sprinter: db.t("vehicles")[1].id };
  // DRAFT pricing only, to start with.
  db.seed("pricing_configs", [{ vehicle_id: ids.eclass, status: "draft", per_mile: 6, hourly_rate: 100, minimum_fare: 100, base_fare: 0, hourly_included_miles: 20, hourly_included_scope: "booking", hourly_extra_mile_rate: 3, min_hours: 2, currency: "USD" }]);
  db.seed("admin_users", [{ user_id: "admin-1", email: "a@x.com" }]);
  routes = {
    quote: await import("../src/app/api/fare/quote/route.ts"),
    bookings: await import("../src/app/api/bookings/route.ts"),
    qr: await import("../src/app/api/quote-requests/route.ts"),
    respond: await import("../src/app/api/quote-requests/respond/route.ts"),
    send: await import("../src/app/api/admin/quotes/send/route.ts"),
    convert: await import("../src/app/api/admin/quotes/convert/route.ts"),
    crud: await import("../src/app/api/admin/crud/route.ts"),
    contact: await import("../src/app/api/contact/route.ts"),
    retry: await import("../src/app/api/admin/notifications/retry/route.ts"),
    notes: await import("../src/app/api/admin/notes/route.ts"),
    ops: await import("../src/app/api/admin/bookings/ops/route.ts"),
    feed: await import("../src/app/api/admin/notifications/feed/route.ts"),
    read: await import("../src/app/api/admin/notifications/read/route.ts"),
    sign: await import("../src/app/api/admin/cloudinary/sign/route.ts"),
    checkout: await import("../src/app/api/payments/checkout/route.ts"),
    webhook: await import("../src/app/api/stripe/webhook/route.ts"),
  };
});

test("draft pricing is never used for customer quotes", async () => {
  const res = await routes.quote.POST(post("/api/fare/quote", trip()));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.pricingAvailable, false);
  assert.ok(data.vehicles.length === 2);
  assert.ok(data.vehicles.every((v: any) => v.quotable === false && Object.keys(v.quotes).length === 0));
  assert.ok(!JSON.stringify(data).includes('"per_mile"'));
});

test("with ACTIVE pricing: real route distance, toll-aware options, surcharge, capacity filter", async () => {
  db.t("pricing_configs")[0].status = "active";
  db.seed("pricing_surcharges", [{ pricing_config_id: db.t("pricing_configs")[0].id, label: "Service fee", kind: "flat", amount: 10, is_active: true }]);

  const res = await routes.quote.POST(post("/api/fare/quote", trip()));
  const data = await res.json();
  assert.equal(data.pricingAvailable, true);
  assert.deepEqual(data.routes.map((r: any) => r.key), ["fastest", "no_tolls"]);
  const ec = data.vehicles.find((v: any) => v.name === "E-Class");
  assert.equal(ec.quotes.fastest.totalCents, 20 * 6 * 100 + 1000); // 20 mi x $6 + $10 fee
  assert.equal(ec.quotes.fastest.tollStatus, "unavailable");        // toll price unknown: not invented
  assert.equal(data.routes[1].distanceMiles, 22);
  assert.equal(ec.quotes.no_tolls.totalCents, 22 * 6 * 100 + 1000);
  assert.equal(ec.quotes.no_tolls.tollStatus, "avoided");
  const sprinter = data.vehicles.find((v: any) => v.name === "Sprinter");
  assert.equal(sprinter.quotable, false); // no pricing configured at all

  // Routes API was asked for tolls and real road routing
  const rc = net.calls.filter((c) => c.url.includes("routes.googleapis"));
  assert.ok(rc.some((c) => c.body.extraComputations?.includes("TOLLS")));
  assert.equal(rc[0].body.intermediates.length, 1);

  const big = await (await routes.quote.POST(post("/api/fare/quote", trip({ passengers: 6 })))).json();
  assert.ok(!big.vehicles.some((v: any) => v.name === "E-Class"));
});

test("known toll estimates are added; hourly quotes include extra-mile charges", async () => {
  net.tollMode = "known";
  const d = await (await routes.quote.POST(post("/api/fare/quote", trip()))).json();
  const ec = d.vehicles.find((v: any) => v.name === "E-Class");
  assert.equal(ec.quotes.fastest.totalCents, 12000 + 1000 + 450);
  net.tollMode = "unknown";
  const h = await (await routes.quote.POST(post("/api/fare/quote", trip({ tripType: "hourly", hours: 3 })))).json();
  const q = h.vehicles.find((v: any) => v.name === "E-Class").quotes.fastest;
  assert.equal(q.totalCents, 3 * 100 * 100 + 0 + 1000); // 20 mi within the 20-mile allowance
  const h2 = await (await routes.quote.POST(post("/api/fare/quote", trip({ tripType: "hourly", hours: 3 })))).json();
  assert.equal(h2.vehicles.find((v: any) => v.name === "E-Class").quotes.no_tolls.totalCents, 30000 + 2 * 3 * 100 + 1000); // 22 mi: 2 extra
});

test("quote rejects bad input and cross-origin requests", async () => {
  assert.equal((await routes.quote.POST(post("/api/fare/quote", trip({ date: "2020-01-01" })))).status, 422);
  assert.equal((await routes.quote.POST(post("/api/fare/quote", trip({ pickup: { text: "" } })))).status, 422);
  assert.equal((await routes.quote.POST(post("/api/fare/quote", trip(), { origin: "http://evil.test" }))).status, 403);
});

test("booking: server recalculates the fare, ignores browser prices, saves CRM data, survives notification failure", async () => {
  net.emailOk = false;
  const body = { ...ack, trip: trip(), vehicleId: ids.eclass, routeKey: "fastest", name: "Ann Rider", email: "Ann@Example.com", phone: "(410) 555-0100", notes: "Flight UA1", submissionKey: "key-aaaaaaaaaaaaaaaa", totalCents: 1, estimatedFare: 1 };
  const res = await routes.bookings.POST(post("/api/bookings", body));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.match(data.reference, /^VT-\d+$/);
  assert.equal(data.totalCents, 13000); // $120 + $10 fee; NOT the 1 cent sent by the browser

  const b = db.t("bookings")[0];
  assert.equal(b.estimated_fare_cents, 13000);
  assert.equal(b.status, "new_request");
  assert.equal(db.t("customers").length, 1);
  assert.equal(db.t("customers")[0].email_normalized, "ann@example.com");
  assert.equal(db.t("booking_stops").length, 1);
  const snap = db.t("pricing_snapshots")[0];
  assert.equal(snap.total_cents, 13000);
  assert.equal(snap.snapshot.config.perMile, 6); // frozen copy of the rates used

  // Brevo is mocked to fail: the booking is still saved, the failure is logged, and the admin alert exists.
  const logs = db.t("notification_logs").filter((l: any) => l.event === "booking.created");
  assert.equal(logs.length, 2); // business + customer, no duplicates
  assert.ok(logs.every((l: any) => l.channel === "email" && l.status === "failed" && /Brevo 401/.test(l.error)));
  assert.equal(db.t("notification_logs").filter((l: any) => l.channel === "sms").length, 0);
  assert.equal(db.t("admin_notifications").length, 1);
  assert.match(db.t("admin_notifications")[0].link, /^\/admin\/bookings\//);
  const call = net.calls.find((c) => c.url === "https://api.brevo.com/v3/smtp/email")!;
  assert.equal(call.headers["api-key"], "brevo-test-key");
  assert.equal(call.body.sender.email, "sender@example.com");
  assert.ok(!JSON.stringify(call.body).includes("brevo-test-key")); // key is a header only
});

test("duplicate submission returns the same booking and sends no second notification", async () => {
  const before = { b: db.t("bookings").length, n: db.t("notification_logs").length };
  const res = await routes.bookings.POST(post("/api/bookings", { ...ack, trip: trip(), vehicleId: ids.eclass, routeKey: "fastest", name: "Ann Rider", email: "ann@example.com", phone: "4105550100", submissionKey: "key-aaaaaaaaaaaaaaaa" }));
  assert.equal(res.status, 200);
  assert.equal(db.t("bookings").length, before.b);
  assert.equal(db.t("notification_logs").length, before.n);
});

test("returning customers are matched by email or phone instead of duplicated", async () => {
  const mk = (extra: object) => ({ ...ack, trip: trip(), vehicleId: ids.eclass, routeKey: "fastest", ...extra });
  await routes.bookings.POST(post("/api/bookings", mk({ name: "Ann R", email: "ann@example.com", phone: "4105559999", submissionKey: "key-bbbbbbbbbbbbbbbb" })));
  await routes.bookings.POST(post("/api/bookings", mk({ name: "Ann Again", email: "different@example.com", phone: "+1 410 555 0100", submissionKey: "key-cccccccccccccccc" })));
  assert.equal(db.t("customers").length, 1);
  assert.equal(db.t("bookings").length, 3);
});

test("retry sends a previously failed email once Brevo accepts it", async () => {
  net.emailOk = true;
  globalThis.__cookies = { vt_at: "good" };
  const failed = db.t("notification_logs").find((l: any) => l.channel === "email" && l.status === "failed");
  const res = await routes.retry.POST(post("/api/admin/notifications/retry", { id: failed.id }));
  assert.equal(res.status, 200);
  assert.equal(failed.status, "sent");
  assert.equal(failed.attempts, 2);
});

test("booking validation, honeypot and unavailable vehicles", async () => {
  const ok = { ...ack, trip: trip(), vehicleId: ids.eclass, routeKey: "fastest", name: "Bo", email: "bo@example.com", phone: "4105550111" };
  assert.equal((await routes.bookings.POST(post("/api/bookings", { ...ok, phone: "123" }))).status, 422);
  assert.equal((await routes.bookings.POST(post("/api/bookings", { ...ok, email: "nope" }))).status, 422);
  const n = db.t("bookings").length;
  assert.equal((await routes.bookings.POST(post("/api/bookings", { ...ok, website: "spam" }))).status, 200);
  assert.equal(db.t("bookings").length, n); // bot: pretend success, store nothing
  assert.equal((await routes.bookings.POST(post("/api/bookings", { ...ok, trip: trip({ passengers: 9 }) }))).status, 422); // too many for E-Class
  assert.equal((await routes.bookings.POST(post("/api/bookings", { ...ok, vehicleId: "00000000-0000-4000-8000-000000000000" }))).status, 422);
});

test("vehicle without published pricing can still be requested; no invented price or snapshot", async () => {
  const snaps = db.t("pricing_snapshots").length;
  const res = await routes.bookings.POST(post("/api/bookings", { ...ack, trip: trip({ passengers: 10 }), vehicleId: ids.sprinter, routeKey: "fastest", name: "Group Lead", email: "grp@example.com", phone: "4105550122", submissionKey: "key-dddddddddddddddd" }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.totalCents, null);
  assert.equal(db.t("pricing_snapshots").length, snaps);
});

const next = (days: number) => new Date(Date.now() + (30 + days) * 86400_000).toISOString().slice(0, 10);
const person = { name: "Ann Rider", email: "ann@example.com", phone: "4105550100" };
const rtTrip = (o: object = {}) => trip({ stops: [], returnLeg: { pickup: { text: "Dulles Airport" }, dropoff: { text: "1 Main St, Baltimore" }, date: next(1), time: "17:00" }, ...o });

test("round trip: both legs priced, no discount invented, configured discount applied server-side, legs and snapshot saved", async () => {
  // No active rule yet: sum of two legs, no discount.
  const none = await (await routes.quote.POST(post("/api/fare/quote", rtTrip()))).json();
  const q0 = none.vehicles.find((v: any) => v.name === "E-Class").quotes.fastest;
  assert.equal(q0.roundTrip.discountCents, 0);
  assert.equal(q0.totalCents, 2 * 13000); // two legs, each 20 mi x $6 + $10 fee

  db.seed("round_trip_rules", [{ label: "Round-trip savings", kind: "percent", amount: 10, category_id: null, is_active: true }]);
  const d = await (await routes.quote.POST(post("/api/fare/quote", rtTrip()))).json();
  const q = d.vehicles.find((v: any) => v.name === "E-Class").quotes.fastest;
  assert.equal(q.roundTrip.twoOneWayCents, 26000);
  assert.equal(q.roundTrip.discountCents, 2600);
  assert.equal(q.totalCents, 23400);
  assert.ok(q.lineItems.some((l: any) => l.code === "round_trip_discount" && l.cents === -2600));

  // Bad return times are rejected.
  assert.equal((await routes.quote.POST(post("/api/fare/quote", rtTrip({ returnLeg: { pickup: { text: "A" }, dropoff: { text: "B" }, date: next(-1), time: "08:00" } })))).status, 422);

  const res = await routes.bookings.POST(post("/api/bookings", { ...ack, ...person, trip: rtTrip(), vehicleId: ids.eclass, routeKey: "fastest", submissionKey: "key-rt-aaaaaaaaaaaa", totalCents: 1 }));
  assert.equal(res.status, 200);
  const b = db.t("bookings").find((x: any) => x.submission_key === "key-rt-aaaaaaaaaaaa");
  assert.equal(b.trip_direction, "round_trip");
  assert.equal(b.estimated_fare_cents, 23400);
  const legs = db.t("booking_legs").filter((l: any) => l.booking_id === b.id).sort((a: any, c: any) => a.leg_number - c.leg_number);
  assert.deepEqual(legs.map((l: any) => [l.direction, l.fare_cents]), [["outbound", 13000], ["return", 13000]]);
  assert.equal(legs[1].pickup_address, "Dulles Airport");
  const snap = db.t("pricing_snapshots").find((x: any) => x.booking_id === b.id);
  assert.equal(snap.snapshot.roundTrip.discountCents, 2600);
  assert.equal(snap.snapshot.roundTrip.legs.length, 2);

  // Changing the rule later does not change the saved booking.
  db.t("round_trip_rules")[0].amount = 50;
  assert.equal(b.estimated_fare_cents, 23400);
  db.t("round_trip_rules")[0].is_active = false;
});

test("booking for someone else: separate booker/passenger, contacts, airport and Meet & Greet requested (charge pending until approved)", async () => {
  const body = {
    ...ack, ...person, trip: trip({ stops: [] }), vehicleId: ids.eclass, routeKey: "fastest", submissionKey: "key-other-aaaaaaaa", bookingFor: "other",
    passenger: { name: "Grace Rider", phone: "4105550177", email: "" }, luggageCount: 3, assistanceNotes: "Needs help with bags", pickupInstructions: "Side door",
    contacts: [{ name: "Sam Rider", relationship: "Son", phone: "4435550123", type: "emergency" }, { name: "", phone: "" }],
    airport: { airport: "Dulles Airport", airline: "United", flightNumber: "UA1", direction: "departure", flightDate: soon, flightTime: "11:00", terminal: "B", passengerName: "Grace Rider", meetGreet: true },
  };
  // Missing acknowledgement and missing passenger details are rejected before anything is saved.
  const n0 = db.t("bookings").length;
  assert.equal((await routes.bookings.POST(post("/api/bookings", { ...body, policiesAcknowledged: false }))).status, 422);
  assert.equal((await routes.bookings.POST(post("/api/bookings", { ...body, passenger: { name: "", phone: "" } }))).status, 422);
  assert.equal(db.t("bookings").length, n0);

  const res = await routes.bookings.POST(post("/api/bookings", body));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.totalCents, 13000); // Meet & Greet has no approved charge: not added, not invented
  const b = db.t("bookings").find((x: any) => x.reference === data.reference);
  assert.equal(b.booking_for, "other");
  assert.equal(b.luggage_count, 3);
  assert.ok(b.policies_acknowledged_at);
  assert.equal(b.policy_snapshot.waitingIncludedMinutes, 15);
  assert.equal(b.service_region, "dmv"); // Baltimore to Dulles: primary service area
  assert.equal(b.requires_manual_review, false);
  const people = db.t("booking_people").filter((p: any) => p.booking_id === b.id);
  assert.deepEqual(people.map((p: any) => p.role).sort(), ["booker", "emergency_contact", "passenger"]);
  assert.equal(people.find((p: any) => p.role === "booker").full_name, "Ann Rider");
  assert.equal(people.find((p: any) => p.role === "passenger").full_name, "Grace Rider");
  const air = db.t("booking_airport_details").find((a: any) => a.booking_id === b.id);
  assert.equal(air.meet_greet_requested, true);
  assert.equal(air.meet_greet_status, "requested"); // requested, not confirmed
  assert.equal(air.meet_greet_charge_cents, null);

  // Emergency contacts, passenger phone and notes never appear in emails or admin alerts.
  const blob = JSON.stringify([db.t("notification_logs"), db.t("admin_notifications")]);
  for (const secret of ["4435550123", "Sam Rider", "4105550177", "Side door", "Needs help with bags"]) assert.ok(!blob.includes(secret), secret);

  // Once an admin approves a charge, it is added to the server-calculated total.
  db.seed("booking_settings", [{ meet_greet_enabled: true, meet_greet_charge_cents: 2500, meet_greet_charge_approved: true, waiting_included_minutes: 15, waiting_increment_minutes: 15, waiting_rate_cents: null, waiting_rate_approved: false }]);
  const res2 = await routes.bookings.POST(post("/api/bookings", { ...body, submissionKey: "key-other-bbbbbbbb" }));
  assert.equal((await res2.json()).totalCents, 15500);
  db.t("booking_settings")[0].meet_greet_enabled = false;
  assert.equal((await routes.bookings.POST(post("/api/bookings", { ...body, submissionKey: "key-other-cccccccc" }))).status, 422); // M&G unavailable
  db.t("booking_settings")[0].meet_greet_enabled = true;
});

test("admin: no-show requires a reason and records staff + charge status; waiting time uses only an approved rate", async () => {
  globalThis.__cookies = { vt_at: "good" };
  const b = db.t("bookings").find((x: any) => x.submission_key === "key-aaaaaaaaaaaaaaaa");
  const ops = (body: object) => routes.ops.POST(post("/api/admin/bookings/ops", { id: b.id, ...body }));
  assert.equal((await ops({ action: "no_show", reason: "" })).status, 422);
  assert.equal((await ops({ action: "no_show", reason: "Passenger did not appear", chargeDollars: "130", chargeStatus: "pending" })).status, 200);
  assert.equal(b.status, "no_show");
  assert.equal(b.no_show_marked_by_email, "a@x.com");
  assert.equal(b.no_show_charge_cents, 13000);
  assert.equal(b.no_show_charge_status, "pending"); // recorded only; nothing is charged
  const w = await (await ops({ action: "waiting", minutesWaited: 40 })).json();
  assert.equal(w.billableMinutes, 30); // 40 min - 15 included, in 15-minute increments
  assert.equal(w.chargeCents, null);   // no approved rate: no invented price
  assert.equal(b.waiting_charge_status, "none");
  db.t("booking_settings")[0].waiting_rate_cents = 1500; db.t("booking_settings")[0].waiting_rate_approved = true;
  assert.equal((await (await ops({ action: "waiting", minutesWaited: 40 })).json()).chargeCents, 3000);
  assert.equal(b.waiting_charge_status, "pending");
  globalThis.__cookies = {};
  assert.equal((await ops({ action: "no_show", reason: "x" })).status, 401);
});

test("admin notification feed: authenticated, per-admin read state, no passenger details", async () => {
  globalThis.__cookies = {};
  assert.equal((await routes.feed.GET()).status, 401);
  globalThis.__cookies = { vt_at: "good" };
  const f = await (await routes.feed.GET()).json();
  assert.ok(f.items.length >= 3 && f.unread === f.items.length);
  const text = JSON.stringify(f.items);
  for (const secret of ["Ann Rider", "ann@example.com", "Grace", "Main St", "4105550100"]) assert.ok(!text.includes(secret), secret);
  assert.equal((await routes.read.POST(post("/api/admin/notifications/read", { id: f.items[0].id }))).status, 200);
  assert.equal((await (await routes.feed.GET()).json()).unread, f.unread - 1);
  await routes.read.POST(post("/api/admin/notifications/read", { all: true }));
  assert.equal((await (await routes.feed.GET()).json()).unread, 0);
  // Alerts are only created after records are saved, once per event (dedupe key).
  const keys = db.t("admin_notifications").map((n: any) => n.dedupe_key);
  assert.equal(new Set(keys).size, keys.length);
});

let quoteId = "", token = "";
test("Request a Better Quote: saved, linked to the customer, original quote computed server-side, business notified", async () => {
  const res = await routes.qr.POST(post("/api/quote-requests", { trip: trip(), vehicleId: ids.eclass, routeKey: "fastest", name: "Dee", email: "dee@example.com", phone: "4105550133", desiredBudget: "90", message: "Can you do $90?", submissionKey: "key-eeeeeeeeeeeeeeee", originalQuote: 1 }));
  assert.equal(res.status, 200);
  const q = db.t("quote_requests")[0];
  quoteId = q.id; token = q.access_token;
  assert.equal(q.original_quote_cents, 13000);
  assert.equal(q.desired_budget_cents, 9000);
  assert.equal(q.discount_decision, "pending"); // never auto-approved
  assert.ok(q.customer_id);
  assert.ok(db.t("notification_logs").some((l: any) => l.event === "quote.created"));
  assert.equal((await routes.qr.POST(post("/api/quote-requests", { trip: trip(), vehicleId: ids.eclass, name: "Dee", email: "dee@example.com", phone: "4105550133", submissionKey: "key-eeeeeeeeeeeeeeee" }))).status, 200);
  assert.equal(db.t("quote_requests").length, 1); // duplicate ignored
});

test("admin endpoints require a signed-in admin and same-origin", async () => {
  globalThis.__cookies = {};
  assert.equal((await routes.send.POST(post("/api/admin/quotes/send", { id: quoteId }))).status, 401);
  globalThis.__cookies = { vt_at: "bad" };
  assert.equal((await routes.crud.POST(post("/api/admin/crud", { resource: "faqs", action: "create", values: {} }))).status, 401);
  globalThis.__cookies = { vt_at: "good" };
  assert.equal((await routes.crud.POST(post("/api/admin/crud", { resource: "faqs", action: "create", values: {} }, { origin: "http://evil.test" }))).status, 403);
  db.t("admin_users").length = 0; // valid session but not an admin
  assert.equal((await routes.crud.POST(post("/api/admin/crud", { resource: "faqs", action: "create", values: {} }))).status, 401);
  db.seed("admin_users", [{ user_id: "admin-1", email: "a@x.com" }]);
});

test("admin sends a revised quote; customer accepts once; admin converts to a booking at the agreed price", async () => {
  globalThis.__cookies = { vt_at: "good" };
  const q = db.t("quote_requests")[0];
  assert.equal((await routes.send.POST(post("/api/admin/quotes/send", { id: quoteId }))).status, 422); // no revised price yet
  q.revised_price_cents = 10500;
  const sent = await routes.send.POST(post("/api/admin/quotes/send", { id: quoteId }));
  assert.equal(sent.status, 200);
  const sd = await sent.json();
  assert.ok(sd.link.endsWith("/quote/" + token));
  assert.equal(q.status, "revised_sent");
  const mailLog = db.t("notification_logs").find((l: any) => l.event === "quote.revised_sent");
  assert.equal(mailLog.status, "sent");
  assert.equal(mailLog.payload.to.email, "dee@example.com"); // revised quote is emailed to the customer
  assert.equal(mailLog.channel, "email");

  assert.equal((await routes.convert.POST(post("/api/admin/quotes/convert", { id: quoteId }))).status, 422); // not accepted yet
  assert.equal((await routes.respond.POST(post("/api/quote-requests/respond", { token: "0".repeat(40), action: "accept" }))).status, 404);
  assert.equal((await routes.respond.POST(post("/api/quote-requests/respond", { token, action: "accept" }))).status, 200);
  assert.equal(q.status, "accepted");
  assert.equal((await routes.respond.POST(post("/api/quote-requests/respond", { token, action: "reject" }))).status, 409);

  const conv = await routes.convert.POST(post("/api/admin/quotes/convert", { id: quoteId }));
  assert.equal(conv.status, 200);
  const cd = await conv.json();
  const booking = db.t("bookings").find((b: any) => b.id === cd.bookingId);
  assert.equal(booking.estimated_fare_cents, 10500);
  assert.equal(booking.source_quote_request_id, quoteId);
  const snap = db.t("pricing_snapshots").find((s: any) => s.booking_id === booking.id);
  assert.equal(snap.snapshot.override.priceCents, 10500);
  assert.equal(snap.snapshot.override.originalTotalCents, 13000);
  assert.equal(q.converted_booking_id, booking.id);
  assert.equal((await routes.convert.POST(post("/api/admin/quotes/convert", { id: quoteId }))).status, 409);
});

test("admin CRUD: whitelisting, validation, pricing activation archives the old config, status emails", async () => {
  globalThis.__cookies = { vt_at: "good" };
  const c = (b: object) => routes.crud.POST(post("/api/admin/crud", b));
  assert.equal((await c({ resource: "nope", action: "create", values: {} })).status, 400);
  assert.equal((await c({ resource: "faqs", action: "create", values: { question: "Q?" } })).status, 422); // answer required
  const created = await c({ resource: "faqs", action: "create", values: { question: "Q?", answer: "A.", is_active: true, evil: "x" } });
  assert.equal(created.status, 200);
  const faq = db.t("faqs")[0];
  assert.equal(faq.sort_order, 1);
  assert.equal("evil" in faq, false);
  await c({ resource: "faqs", action: "create", values: { question: "Q2?", answer: "A2.", is_active: true } });
  await c({ resource: "faqs", action: "move", id: db.t("faqs")[1].id, direction: "up" });
  assert.equal(db.t("faqs").find((f: any) => f.question === "Q2?").sort_order, 1);

  assert.equal((await c({ resource: "bookings", action: "create", values: {} })).status, 403); // not creatable
  assert.equal((await c({ resource: "bookings", action: "update", id: db.t("bookings")[0].id, values: { status: "bogus" } })).status, 422);

  const oldActive = db.t("pricing_configs").find((p: any) => p.status === "active");
  const vals = { vehicle_id: ids.eclass, status: "active", currency: "USD", per_mile: 7, minimum_fare: 120, min_hours: 2, hourly_included_miles: 20, hourly_included_scope: "booking", hourly_extra_mile_rate: 4 };
  assert.equal((await c({ resource: "pricing", action: "create", values: vals })).status, 200);
  assert.equal(oldActive.status, "archived");
  assert.equal(db.t("pricing_configs").filter((p: any) => p.vehicle_id === ids.eclass && p.status === "active").length, 1);

  // Confirmed is always emailed; other statuses only when the setting is on; no-show goes through its own action.
  const bid = db.t("bookings")[0].id;
  const statusLogs = () => db.t("notification_logs").filter((l: any) => l.event === "booking.status_changed").length;
  const before = statusLogs();
  await c({ resource: "bookings", action: "update", id: bid, values: { status: "confirmed" } });
  assert.equal(statusLogs(), before + 1);
  await c({ resource: "bookings", action: "update", id: bid, values: { status: "assigned" } });
  assert.equal(statusLogs(), before + 1); // setting off
  db.seed("site_content", [{ key: "settings.notify_status_changes", value: true }]);
  await c({ resource: "bookings", action: "update", id: bid, values: { status: "in_progress" } });
  assert.equal(statusLogs(), before + 2);
  assert.equal((await c({ resource: "bookings", action: "update", id: bid, values: { status: "no_show" } })).status, 422);
});

test("admin notes are validated", async () => {
  globalThis.__cookies = { vt_at: "good" };
  const bid = db.t("bookings")[0].id;
  assert.equal((await routes.notes.POST(post("/api/admin/notes", { entityType: "booking", entityId: bid, body: "Called customer" }))).status, 200);
  assert.equal((await routes.notes.POST(post("/api/admin/notes", { entityType: "hack", entityId: bid, body: "x" }))).status, 422);
  assert.equal(db.t("crm_notes").length, 1);
});

test("contact form: saved to CRM, honeypot ignored, validation enforced, rate limited", async () => {
  const ok = { name: "Cy", email: "cy@example.com", phone: "", message: "Do you serve weddings?" };
  assert.equal((await routes.contact.POST(post("/api/contact", ok))).status, 200);
  assert.equal(db.t("leads").length, 1);
  assert.ok(db.t("notification_logs").some((l: any) => l.event === "lead.created"));
  const n = db.t("leads").length;
  assert.equal((await routes.contact.POST(post("/api/contact", { ...ok, website: "bot" }))).status, 200);
  assert.equal(db.t("leads").length, n);
  assert.equal((await routes.contact.POST(post("/api/contact", { ...ok, email: "bad" }))).status, 422);
  const same = { "x-forwarded-for": "9.9.9.9" };
  let last = 200;
  for (let i = 0; i < 7; i++) last = (await routes.contact.POST(post("/api/contact", ok, same))).status;
  assert.equal(last, 429);
});

test("missing credentials degrade gracefully instead of crashing", async () => {
  const saved = { ...process.env };
  delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
  const r = await routes.quote.POST(post("/api/fare/quote", trip()));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, "not_configured");
  process.env.GOOGLE_MAPS_SERVER_API_KEY = saved.GOOGLE_MAPS_SERVER_API_KEY;

  delete process.env.BREVO_API_KEY;
  const before = db.t("bookings").length;
  const res = await routes.bookings.POST(post("/api/bookings", { ...ack, trip: trip(), vehicleId: ids.eclass, routeKey: "fastest", name: "Eve", email: "eve@example.com", phone: "4105550144", submissionKey: "key-ffffffffffffffff" }));
  assert.equal(res.status, 200);
  assert.equal(db.t("bookings").length, before + 1); // saved with no providers configured
  const skipped = db.t("notification_logs").filter((l: any) => l.status === "skipped");
  assert.ok(skipped.length >= 2); // emails skipped, nothing crashed
  process.env.BREVO_API_KEY = saved.BREVO_API_KEY;
});

test("out-of-area request is saved for manual review without a vehicle, route or price; notifies the business", async () => {
  const mockCalls = net.calls.length;
  const res = await routes.qr.POST(post("/api/quote-requests", { trip: { pickup: { text: "Charles de Gaulle Airport, Paris, France" }, dropoff: { text: "London, England" }, stops: [], date: soon, time: "10:00", tripType: "distance", passengers: 3 }, name: "Pat Roe", email: "pat@example.com", phone: "4105550166", message: "Family trip", submissionKey: "key-paris-aaaaaaaaa" }));
  assert.equal(res.status, 200);
  const q = db.t("quote_requests").find((x: any) => x.email === "pat@example.com");
  assert.equal(q.source, "manual");
  assert.equal(q.service_region, "other");
  assert.equal(q.original_quote_cents, null);
  assert.equal(net.calls.slice(mockCalls).filter((c) => c.url.includes("routes.googleapis")).length, 0);
  assert.ok(db.t("admin_notifications").some((n: any) => n.event === "quote.created"));
});



// =====================================================================================================
// Child seats, capacity, photos (Cloudinary) and online payments (Stripe)
// =====================================================================================================
let pk = 0;
const makeBooking = async (extra: Record<string, unknown> = {}, tripOver: Record<string, unknown> = {}) => {
  const res = await routes.bookings.POST(post("/api/bookings", { ...ack, ...person, trip: trip({ stops: [], passengers: 2, ...tripOver }), vehicleId: ids.eclass, routeKey: "fastest", submissionKey: `pk-${++pk}-aaaaaaaaaaaaaaaaaa`, ...extra }));
  const data = await res.json();
  return { res, data, row: db.t("bookings").find((b: any) => b.reference === data.reference) };
};
const quoteFor = async (t: object) => { const d = await (await routes.quote.POST(post("/api/fare/quote", t))).json(); return { d, ec: d.vehicles?.find((v: any) => v.name === "E-Class")?.quotes?.fastest }; };

test("child seats: priced on the server (one way per seat; round trip per seat ONCE), validated, saved with the booking", async () => {
  const seats = { rear_facing: 1, booster: 1 };
  const baseOne = (await quoteFor(trip({ passengers: 3 }))).ec.totalCents;
  const baseRt = (await quoteFor(rtTrip({ passengers: 3 }))).ec.totalCents; // server-priced baselines without seats
  const one = await quoteFor(trip({ passengers: 3, childSeats: seats }));
  assert.equal(one.ec.totalCents, baseOne + 2 * 1000);
  assert.equal(one.ec.lineItems.filter((l: any) => l.code === "child_seat").length, 1);
  assert.deepEqual(one.d.seatInfo, { oneWayCents: 1000, roundTripCents: 1500, max: 4 });

  const rt = await quoteFor(rtTrip({ passengers: 3, childSeats: seats }));
  assert.equal(rt.ec.totalCents, baseRt + 2 * 1500); // the $15 round-trip rate is added once, not once per leg
  assert.equal(rt.ec.lineItems.filter((l: any) => l.code === "child_seat").length, 1);

  assert.equal((await routes.quote.POST(post("/api/fare/quote", trip({ passengers: 3, childSeats: { booster: 5 } })))).status, 422);   // above the maximum
  assert.equal((await routes.quote.POST(post("/api/fare/quote", trip({ passengers: 2, childSeats: { booster: 3 } })))).status, 422);   // more seats than passengers
  assert.equal((await routes.quote.POST(post("/api/fare/quote", trip({ passengers: 3, childSeats: { booster: 1.5 } })))).status, 422);

  // Booking: the browser's total and fee are ignored; the saved fare includes the seats.
  const b = await makeBooking({ totalCents: 1, childSeatFeeCents: 1 }, { passengers: 3, childSeats: seats });
  assert.equal(b.res.status, 200);
  assert.equal(b.row.estimated_fare_cents, baseOne + 2000);
  assert.equal(b.row.child_seat_fee_cents, 2000);
  assert.deepEqual(b.row.child_seats, [{ type: "rear_facing", quantity: 1 }, { type: "booster", quantity: 1 }]);
  const snap = db.t("pricing_snapshots").find((x: any) => x.booking_id === b.row.id);
  assert.ok(snap.line_items.some((l: any) => l.code === "child_seat" && l.cents === 2000));
  assert.match(JSON.stringify(db.t("notification_logs").filter((l: any) => l.entity_id === b.row.id)), /Child seats: 1 × Rear-facing, 1 × Booster \(requested\)/);

  const rtBooking = await makeBooking({}, { stops: [], passengers: 3, childSeats: seats, returnLeg: { pickup: { text: "Dulles Airport" }, dropoff: { text: "1 Main St, Baltimore" }, date: next(1), time: "17:00" } });
  assert.equal(rtBooking.row.estimated_fare_cents, baseRt + 3000);
  assert.equal(rtBooking.row.child_seat_fee_cents, 3000);

  // Admin-configurable rate: a price change applies to new quotes and leaves saved bookings alone.
  db.t("booking_settings")[0].child_seat_one_way_cents = 1200;
  assert.equal((await quoteFor(trip({ passengers: 3, childSeats: seats }))).ec.totalCents, baseOne + 2 * 1200);
  assert.equal(b.row.estimated_fare_cents, baseOne + 2000);
  db.t("booking_settings")[0].child_seat_one_way_cents = 1000;
});

test("vehicle capacity is enforced on the server, regardless of what the browser shows", async () => {
  const { d } = await quoteFor(trip({ passengers: 5 }));
  assert.ok(!d.vehicles.some((v: any) => v.name === "E-Class")); // capacity 4: not offered for 5 passengers
  const before = db.t("bookings").length;
  const forced = await makeBooking({}, { passengers: 5 }); // crafted request for the 4-seat vehicle
  assert.equal(forced.res.status, 422);
  assert.equal(db.t("bookings").length, before);
  assert.equal((await makeBooking({}, { passengers: 4 })).res.status, 200); // exactly at capacity is allowed
});

test("vehicle photos on the public side: assigned Cloudinary photo is shown, otherwise null (branded placeholder)", async () => {
  const none = await quoteFor(trip());
  assert.equal(none.d.vehicles.find((v: any) => v.name === "E-Class").image, null); // legacy SVG illustration is not treated as a photo
  const v = db.t("vehicles")[0];
  v.image_url = "https://res.cloudinary.com/democloud/image/upload/v1/vanta/vehicles/eclass.jpg"; v.image_public_id = "vanta/vehicles/eclass";
  assert.equal((await quoteFor(trip())).d.vehicles.find((x: any) => x.name === "E-Class").image, v.image_url);
  v.image_url = "/vehicles/sedan.svg"; v.image_public_id = null;
});

test("Cloudinary: uploads are signed server-side for admins only, with type/size limits; the secret never leaves the server", async () => {
  const sign = (b: object) => routes.sign.POST(post("/api/admin/cloudinary/sign", b));
  globalThis.__cookies = {};
  assert.equal((await sign({ contentType: "image/jpeg", size: 1000 })).status, 401);
  assert.equal((await routes.sign.GET()).status, 401);
  globalThis.__cookies = { vt_at: "good" };
  assert.deepEqual(await (await routes.sign.GET()).json(), { configured: true });
  assert.equal((await sign({ contentType: "image/gif", size: 1000 })).status, 422);
  assert.equal((await sign({ contentType: "application/pdf", size: 1000 })).status, 422);
  assert.equal((await sign({ contentType: "image/jpeg", size: 20 * 1024 * 1024 })).status, 422);
  assert.equal((await sign({ contentType: "image/jpeg", size: 0 })).status, 422);
  const ok = await sign({ contentType: "image/webp", size: 500_000 });
  assert.equal(ok.status, 200);
  const raw = await ok.text(); const d = JSON.parse(raw);
  assert.equal(d.folder, "vanta/vehicles");
  assert.equal(d.apiKey, "123456");
  const expected = createHash("sha1").update(`allowed_formats=jpg,jpeg,png,webp&folder=vanta/vehicles&timestamp=${d.timestamp}cloud-secret-xyz`).digest("hex");
  assert.equal(d.signature, expected);
  assert.ok(!raw.includes("cloud-secret-xyz"));
  // Not configured: a clear message, not a crash.
  const saved = process.env.CLOUDINARY_API_SECRET; delete process.env.CLOUDINARY_API_SECRET;
  const nc = await sign({ contentType: "image/jpeg", size: 1000 });
  assert.equal(nc.status, 503); assert.match((await nc.json()).error, /not configured/i);
  assert.deepEqual(await (await routes.sign.GET()).json(), { configured: false });
  process.env.CLOUDINARY_API_SECRET = saved;
  globalThis.__cookies = {};
});

test("Cloudinary: photo assignment persists url + public id; foreign URLs rejected; replaced/removed assets deleted only when unused", async () => {
  globalThis.__cookies = { vt_at: "good" };
  const crud = (id: string, values: object) => routes.crud.POST(post("/api/admin/crud", { resource: "vehicles", action: "update", id, values }));
  const url = (n: string) => `https://res.cloudinary.com/democloud/image/upload/v1/vanta/vehicles/${n}.jpg`;
  const destroys = () => net.calls.filter((c) => c.url.endsWith("/image/destroy")).map((c) => String(c.body instanceof URLSearchParams ? c.body.get("public_id") : ""));
  const sprinter = db.t("vehicles")[1], eclass = db.t("vehicles")[0];
  const n0 = destroys().length;

  assert.equal((await crud(sprinter.id, { image_url: "https://evil.example.com/x.jpg", image_public_id: "vanta/vehicles/x" })).status, 422);
  assert.equal((await crud(sprinter.id, { image_url: url("a"), image_public_id: "other-folder/a" })).status, 422);
  assert.equal((await crud(sprinter.id, { image_url: url("a"), image_public_id: "vanta/vehicles/../a" })).status, 422);
  assert.equal(sprinter.image_public_id ?? null, null);

  assert.equal((await crud(sprinter.id, { image_url: url("a"), image_public_id: "vanta/vehicles/a" })).status, 200);
  assert.equal(sprinter.image_url, url("a")); assert.equal(sprinter.image_public_id, "vanta/vehicles/a");

  // Replace: the old asset is deleted (nothing else uses it).
  assert.equal((await crud(sprinter.id, { image_url: url("b"), image_public_id: "vanta/vehicles/b" })).status, 200);
  assert.deepEqual(destroys().slice(n0), ["vanta/vehicles/a"]);

  // Shared asset: another vehicle still uses "b", so replacing it on the sprinter must NOT delete it.
  eclass.image_url = url("b"); eclass.image_public_id = "vanta/vehicles/b";
  assert.equal((await crud(sprinter.id, { image_url: url("c"), image_public_id: "vanta/vehicles/c" })).status, 200);
  assert.deepEqual(destroys().slice(n0), ["vanta/vehicles/a"]);

  // Editing an unrelated field leaves the photo alone (and does not need Cloudinary to be configured).
  assert.equal((await crud(sprinter.id, { name: "Sprinter", image_url: url("c"), image_public_id: "vanta/vehicles/c" })).status, 200);
  assert.deepEqual(destroys().slice(n0), ["vanta/vehicles/a"]);

  // Remove: clears both columns and deletes the now-unused asset; the public site falls back to the placeholder.
  assert.equal((await crud(sprinter.id, { image_url: "", image_public_id: "" })).status, 200);
  assert.equal(sprinter.image_url, null); assert.equal(sprinter.image_public_id, null);
  assert.deepEqual(destroys().slice(n0), ["vanta/vehicles/a", "vanta/vehicles/c"]);
  eclass.image_url = "/vehicles/sedan.svg"; eclass.image_public_id = null;
  globalThis.__cookies = {};
});

// ---- Stripe ---------------------------------------------------------------------------------------
const hook = (event: object, opts: { secret?: string; at?: number } = {}) => {
  const raw = JSON.stringify(event);
  return new Request("http://site.test/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": signStripePayload(raw, opts.secret ?? "whsec_test", opts.at), "content-type": "application/json" }, body: raw });
};
let ev = 0;
const sessionEvent = (type: string, p: any, over: Record<string, unknown> = {}, id = `evt_${++ev}`) => ({
  id, type, data: { object: { object: "checkout.session", id: p.stripe_session_id, payment_status: "paid", payment_intent: `pi_${p.stripe_session_id}`, amount_total: p.amount_cents, currency: "usd", metadata: { booking_id: p.booking_id, payment_id: p.id }, ...over } },
});
const pay = (token: string, extra: object = {}) => routes.checkout.POST(post("/api/payments/checkout", { token, ...extra }));
const setPay = (mode: string, extra: Record<string, unknown> = {}) => Object.assign(db.t("booking_settings")[0], { payment_mode: mode, deposit_fixed_cents: null, deposit_percent: null, ...extra });

test("payments disabled by default: booking requests work, no checkout is offered", async () => {
  setPay("disabled");
  const b = await makeBooking();
  assert.equal(b.res.status, 200);
  assert.equal(b.data.payUrl, null);
  assert.equal(b.row.payment_status, "not_required");
  const r = await pay(b.row.payment_token);
  assert.equal(r.status, 409);
  assert.equal(db.t("payments").filter((p: any) => p.booking_id === b.row.id).length, 0);
  assert.equal((await pay("not-a-token")).status, 400);
});

test("Stripe Checkout: amount comes only from the saved server-side total; client amounts are ignored; booking is not confirmed or paid", async () => {
  setPay("full");
  const b = await makeBooking({ totalCents: 1 });
  assert.equal(b.data.payUrl, `/pay/${b.row.payment_token}`);
  assert.equal(b.row.payment_status, "unpaid");
  const total = b.row.estimated_fare_cents; assert.ok(total > 0);

  const callsBefore = net.calls.length;
  const r = await pay(b.row.payment_token, { amountCents: 1, amount: 1, totalCents: 1 });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.match(out.url, /^https:\/\/checkout\.stripe\.com\//);
  const sc = net.calls.slice(callsBefore).find((c) => c.url === "https://api.stripe.com/v1/checkout/sessions")!;
  const form = new URLSearchParams(String(sc.body));
  assert.equal(form.get("line_items[0][price_data][unit_amount]"), String(total));
  assert.equal(form.get("line_items[0][price_data][currency]"), "usd");
  assert.equal(form.get("metadata[booking_id]"), b.row.id);
  assert.equal(form.get("customer_email"), "ann@example.com");
  assert.match(String(sc.headers["Idempotency-Key"]), /^pay-/);
  assert.equal(sc.headers.Authorization, "Bearer sk_test_x");

  const p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
  assert.equal(p.status, "pending"); assert.equal(p.amount_cents, total); assert.equal(p.kind, "full");
  assert.equal(b.row.payment_status, "pending");
  assert.equal(b.row.status, "new_request");   // creating a session confirms nothing
  assert.equal(b.row.amount_paid_cents, 0);    // and marks nothing as paid
});

test("Stripe webhook: signature required; paid only via a verified event; booking stays unconfirmed; duplicates are ignored", async () => {
  setPay("full");
  const b = await makeBooking();
  await pay(b.row.payment_token);
  const p = db.t("payments").find((x: any) => x.booking_id === b.row.id);

  const bad = await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p), { secret: "whsec_wrong" }));
  assert.equal(bad.status, 400);
  const stale = await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p), { at: Math.floor(Date.now() / 1000) - 3600 }));
  assert.equal(stale.status, 400);
  const unsigned = await routes.webhook.POST(new Request("http://site.test/api/stripe/webhook", { method: "POST", body: "{}" }));
  assert.equal(unsigned.status, 400);
  assert.equal(p.status, "pending"); assert.equal(b.row.amount_paid_cents, 0);
  assert.equal(db.t("stripe_events").length, 0);

  const good = sessionEvent("checkout.session.completed", p, {}, "evt_dup_1");
  const ok = await routes.webhook.POST(hook(good));
  assert.equal(ok.status, 200); assert.equal((await ok.json()).result, "processed");
  assert.equal(p.status, "paid"); assert.ok(p.paid_at); assert.equal(p.stripe_payment_intent_id, `pi_${p.stripe_session_id}`);
  assert.equal(b.row.amount_paid_cents, p.amount_cents);
  assert.equal(p.amount_cents, b.row.estimated_fare_cents);
  assert.equal(b.row.payment_status, "paid");
  assert.equal(b.row.status, "new_request");   // a payment never confirms the booking
  assert.ok(db.t("admin_notifications").some((n: any) => n.event === "payment.paid" && n.entity_id === b.row.id));
  const mails = db.t("notification_logs").filter((l: any) => l.event === "payment.paid" && l.entity_id === b.row.id);
  assert.deepEqual(mails.map((m: any) => m.payload.audience).sort(), ["business", "customer"]);

  // The same event delivered again changes nothing.
  const dup = await routes.webhook.POST(hook(good));
  assert.equal(dup.status, 200); assert.equal((await dup.json()).result, "duplicate");
  assert.equal(b.row.amount_paid_cents, p.amount_cents);
  assert.equal(db.t("payments").filter((x: any) => x.booking_id === b.row.id).length, 1);
  assert.equal(db.t("notification_logs").filter((l: any) => l.event === "payment.paid" && l.entity_id === b.row.id).length, 2);
  // A different event id for an already-recorded payment is also harmless.
  await routes.webhook.POST(hook(sessionEvent("checkout.session.async_payment_succeeded", p)));
  assert.equal(b.row.amount_paid_cents, p.amount_cents);

  // Refunds arrive by webhook: partial, then full.
  const refund = (amt: number) => ({ id: `evt_r${++ev}`, type: "charge.refunded", data: { object: { object: "charge", id: "ch_1", payment_intent: p.stripe_payment_intent_id, amount_refunded: amt } } });
  await routes.webhook.POST(hook(refund(3000)));
  assert.equal(p.status, "partially_refunded"); assert.equal(b.row.payment_status, "partially_refunded"); assert.equal(b.row.amount_paid_cents, p.amount_cents - 3000);
  await routes.webhook.POST(hook(refund(p.amount_cents)));
  assert.equal(p.status, "refunded"); assert.equal(b.row.payment_status, "refunded"); assert.equal(b.row.amount_paid_cents, 0);
});

test("Stripe webhook: a mismatching amount is flagged for review, never marked paid", async () => {
  setPay("full");
  const b = await makeBooking();
  await pay(b.row.payment_token);
  const p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p, { amount_total: 100 })));
  assert.equal(p.status, "review"); assert.equal(b.row.payment_status, "review"); assert.equal(b.row.amount_paid_cents, 0);
  assert.ok(db.t("admin_notifications").some((n: any) => n.event === "payment.review" && n.entity_id === b.row.id));
});

test("failed or expired payments keep the booking and can be retried; processing errors release the event for Stripe's retry", async () => {
  setPay("full");
  const b = await makeBooking();
  await pay(b.row.payment_token);
  const p1 = db.t("payments").find((x: any) => x.booking_id === b.row.id);

  await routes.webhook.POST(hook(sessionEvent("checkout.session.expired", p1, { payment_status: "unpaid" })));
  assert.equal(p1.status, "expired"); assert.equal(b.row.payment_status, "unpaid");
  assert.ok(db.t("bookings").some((x: any) => x.id === b.row.id)); // the booking is never erased

  const retry = await pay(b.row.payment_token);                    // retry path
  assert.equal(retry.status, 200);
  const p2 = db.t("payments").filter((x: any) => x.booking_id === b.row.id).at(-1);
  assert.notEqual(p2.id, p1.id); assert.equal(p2.status, "pending"); assert.equal(b.row.payment_status, "pending");

  await routes.webhook.POST(hook(sessionEvent("checkout.session.async_payment_failed", p2, { payment_status: "unpaid" })));
  assert.equal(p2.status, "failed"); assert.equal(b.row.payment_status, "failed");
  assert.equal((await pay(b.row.payment_token)).status, 200);      // retry again after a failure

  // A delayed payment method that has not settled yet stays pending.
  const p3 = db.t("payments").filter((x: any) => x.booking_id === b.row.id).at(-1);
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p3, { payment_status: "unpaid" })));
  assert.equal(p3.status, "pending"); assert.equal(b.row.amount_paid_cents, 0);

  // Unexpected failure while processing: 500 and the event id is released so the retry can succeed.
  const evt = sessionEvent("checkout.session.completed", p3, {}, "evt_flaky");
  const realUpdate = db.from.bind(db);
  let boom = true;
  db.from = (t: string) => { if (boom && t === "payments") { const q = realUpdate(t); const u = q.update.bind(q); q.update = () => { throw new Error("db down"); }; void u; return q; } return realUpdate(t); };
  const failed = await routes.webhook.POST(hook(evt));
  db.from = realUpdate; boom = false;
  assert.equal(failed.status, 500);
  assert.equal(db.t("stripe_events").some((e: any) => e.id === "evt_flaky"), false);
  assert.equal((await (await routes.webhook.POST(hook(evt))).json()).result, "processed");
  assert.equal(p3.status, "paid");
});

test("deposit modes: fixed and percentage amounts come from admin settings; unconfigured deposits offer nothing; not configured = unavailable", async () => {
  setPay("deposit_percent", { deposit_percent: 25 });
  let b = await makeBooking();
  assert.equal(b.data.payUrl, `/pay/${b.row.payment_token}`);
  await pay(b.row.payment_token);
  let p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
  assert.equal(p.amount_cents, Math.round(b.row.estimated_fare_cents * 0.25)); assert.equal(p.kind, "deposit");
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p)));
  assert.equal(b.row.payment_status, "deposit_paid"); assert.equal(b.row.amount_paid_cents, p.amount_cents);
  assert.equal((await pay(b.row.payment_token)).status, 409); // deposit already paid: nothing more due online

  setPay("deposit_fixed", { deposit_fixed_cents: 5000 });
  b = await makeBooking(); await pay(b.row.payment_token);
  p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
  assert.equal(p.amount_cents, 5000);

  setPay("deposit_fixed"); // mode chosen but no amount: no invented deposit
  b = await makeBooking();
  assert.equal(b.data.payUrl, null); assert.equal((await pay(b.row.payment_token)).status, 409);

  setPay("full");
  const saved = process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_SECRET_KEY;
  b = await makeBooking();
  assert.equal(b.res.status, 200); assert.equal(b.data.payUrl, null); // booking still saved
  assert.equal((await pay(b.row.payment_token)).status, 503);
  process.env.STRIPE_SECRET_KEY = saved;

  // Cancelled bookings cannot be paid.
  const c = await makeBooking(); c.row.status = "cancelled";
  assert.equal((await pay(c.row.payment_token)).status, 409);
  setPay("disabled");
});
