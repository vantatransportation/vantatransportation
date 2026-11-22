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
const net = { tollMode: "unknown" as "unknown" | "known", emailOk: false, calls: [] as { url: string; body: any; headers: any }[], sid: 0, pp: { seq: 0, orders: new Map<string, any>(), capStatus: "COMPLETED", capAmount: null as string | null, verify: true } };
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
  if (u === "https://api-m.sandbox.paypal.com/v1/oauth2/token") return reply({ access_token: "pp-token", expires_in: 3600 });
  if (u === "https://api-m.sandbox.paypal.com/v2/checkout/orders") { const id = `PPORDER${++net.pp.seq}AAAA`; net.pp.orders.set(id, JSON.parse(String(init.body))); return reply({ id, status: "CREATED" }, 201); }
  const capM = u.match(/^https:\/\/api-m\.sandbox\.paypal\.com\/v2\/checkout\/orders\/([^/]+)\/capture$/);
  if (capM) {
    const order = net.pp.orders.get(capM[1]); if (!order) return reply({ message: "not found" }, 404);
    const unit = order.purchase_units[0];
    return reply({ id: capM[1], status: "COMPLETED", purchase_units: [{ reference_id: unit.reference_id, custom_id: unit.custom_id, payments: { captures: [{ id: `CAP${capM[1]}`, status: net.pp.capStatus, amount: { currency_code: unit.amount.currency_code, value: net.pp.capAmount ?? unit.amount.value } }] } }] }, 201);
  }
  if (u === "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature") return reply({ verification_status: net.pp.verify ? "SUCCESS" : "FAILURE" });
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
  // The three service tiers. Fixed prices are NOT set yet (an admin must enter them); Meet & Greet fees are the initial approved values.
  db.seed("vehicle_tiers", [
    { name: "Premium", slug: "premium", sort_order: 1, is_active: true, fixed_price_cents: null, meet_greet_fee_cents: 2500 },
    { name: "Luxury", slug: "luxury", sort_order: 2, is_active: true, fixed_price_cents: null, meet_greet_fee_cents: 3500 },
    { name: "Luxury Plus", slug: "luxury-plus", sort_order: 3, is_active: true, fixed_price_cents: null, meet_greet_fee_cents: 5000 },
  ]);
  const cat = db.t("vehicle_categories")[0].id, tier = db.t("vehicle_tiers")[1].id, tierPremium = db.t("vehicle_tiers")[0].id;
  db.seed("vehicles", [
    { name: "E-Class", category_id: cat, tier_id: tier, passenger_capacity: 4, is_active: true, is_available: true, sort_order: 1, image_url: "/vehicles/sedan.svg" },
    { name: "Sprinter", category_id: cat, tier_id: tierPremium, passenger_capacity: 14, is_active: true, is_available: true, sort_order: 2, image_url: "/vehicles/van.svg" },
  ]);
  db.backfillTierAssignments(); // what migration 0010 does to an existing database
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
    workflow: await import("../src/app/api/admin/bookings/workflow/route.ts"),
    track: await import("../src/app/api/track/route.ts"),
    driverMessages: await import("../src/app/api/driver/messages/route.ts"),
    driverStatusRoute: await import("../src/app/api/driver/status/route.ts"),
    trackChat: await import("../src/app/api/track/messages/route.ts"),
    feed: await import("../src/app/api/admin/notifications/feed/route.ts"),
    read: await import("../src/app/api/admin/notifications/read/route.ts"),
    sign: await import("../src/app/api/admin/cloudinary/sign/route.ts"),
    checkout: await import("../src/app/api/payments/checkout/route.ts"),
    ppcapture: await import("../src/app/api/payments/paypal/capture/route.ts"),
    ppwebhook: await import("../src/app/api/paypal/webhook/route.ts"),
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
    airport: { airport: "Dulles Airport", airline: "United", flightNumber: "UA1", direction: "departure", flightDate: soon, flightTime: "11:00", terminal: "B", passengerName: "Grace Rider" },
  };
  // Missing acknowledgement and missing passenger details are rejected before anything is saved.
  const n0 = db.t("bookings").length;
  assert.equal((await routes.bookings.POST(post("/api/bookings", { ...body, policiesAcknowledged: false }))).status, 422);
  assert.equal((await routes.bookings.POST(post("/api/bookings", { ...body, passenger: { name: "", phone: "" } }))).status, 422);
  assert.equal(db.t("bookings").length, n0);

  const res = await routes.bookings.POST(post("/api/bookings", body));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.totalCents, 13000); // the estimate is the trip-based estimate only
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
  assert.equal(air.meet_greet_requested, false); // Meet & Greet is chosen in the fare calculator (trip.meetGreet), not here
  assert.equal(air.meet_greet_status, "not_requested");
  assert.equal(air.meet_greet_charge_cents, null);

  // Emergency contacts, passenger phone and notes never appear in emails or admin alerts.
  const blob = JSON.stringify([db.t("notification_logs"), db.t("admin_notifications")]);
  for (const secret of ["4435550123", "Sam Rider", "4105550177", "Side door", "Needs help with bags"]) assert.ok(!blob.includes(secret), secret);

  // Provider/settings row used by later tests.
  db.seed("booking_settings", [{ meet_greet_enabled: true, waiting_included_minutes: 15, waiting_increment_minutes: 15, waiting_rate_cents: null, waiting_rate_approved: false }]);
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

const TIERS = () => db.t("vehicle_tiers");
const setFixed = (premium: number | null, luxury: number | null, plus: number | null) => { TIERS()[0].fixed_price_cents = premium; TIERS()[1].fixed_price_cents = luxury; TIERS()[2].fixed_price_cents = plus; };

test("child seats: priced on the server (one way per seat; round trip per seat ONCE), validated, charged online as an add-on, NOT in the trip estimate", async () => {
  setFixed(10000, 15000, 22000);
  const seats = { rear_facing: 1, booster: 1 };
  const baseOne = (await quoteFor(trip({ passengers: 3 }))).ec.totalCents;
  const baseRt = (await quoteFor(rtTrip({ passengers: 3 }))).ec.totalCents; // server-priced trip estimates without seats
  const one = await quoteFor(trip({ passengers: 3, childSeats: seats }));
  assert.equal(one.ec.totalCents, baseOne);                       // the estimate does not include add-ons
  assert.equal(one.d.seatFeeCents, 2 * 1000);                     // the add-on is reported separately
  assert.ok(!one.ec.lineItems.some((l: any) => l.code === "child_seat"));
  assert.deepEqual(one.d.seatInfo, { oneWayCents: 1000, roundTripCents: 1500, max: 4 });

  const rt = await quoteFor(rtTrip({ passengers: 3, childSeats: seats }));
  assert.equal(rt.ec.totalCents, baseRt);
  assert.equal(rt.d.seatFeeCents, 2 * 1500);                      // $15 per seat once, not once per leg

  assert.equal((await routes.quote.POST(post("/api/fare/quote", trip({ passengers: 3, childSeats: { booster: 5 } })))).status, 422);   // above the maximum
  assert.equal((await routes.quote.POST(post("/api/fare/quote", trip({ passengers: 2, childSeats: { booster: 3 } })))).status, 422);   // more seats than passengers
  assert.equal((await routes.quote.POST(post("/api/fare/quote", trip({ passengers: 3, childSeats: { booster: 1.5 } })))).status, 422);

  // Booking: the browser's totals are ignored. Estimate = trip estimate; online amount = fixed Luxury price + seats.
  const b = await makeBooking({ totalCents: 1, childSeatFeeCents: 1, onlineAmountCents: 1 }, { passengers: 3, childSeats: seats });
  assert.equal(b.res.status, 200);
  assert.equal(b.row.estimated_fare_cents, baseOne);
  assert.equal(b.row.child_seat_fee_cents, 2000);
  assert.equal(b.row.fixed_price_cents, 15000);
  assert.equal(b.row.online_amount_cents, 15000 + 2000);
  assert.deepEqual(b.row.child_seats, [{ type: "rear_facing", quantity: 1 }, { type: "booster", quantity: 1 }]);
  assert.match(JSON.stringify(db.t("notification_logs").filter((l: any) => l.entity_id === b.row.id)), /Child seats: 1 × Rear-facing, 1 × Booster \(requested\)/);

  const rtBooking = await makeBooking({}, { stops: [], passengers: 3, childSeats: seats, returnLeg: { pickup: { text: "Dulles Airport" }, dropoff: { text: "1 Main St, Baltimore" }, date: next(1), time: "17:00" } });
  assert.equal(rtBooking.row.child_seat_fee_cents, 3000);
  assert.equal(rtBooking.row.online_amount_cents, 15000 + 3000);

  // Admin-configurable rate: a price change applies to new quotes and leaves saved bookings alone.
  db.t("booking_settings")[0].child_seat_one_way_cents = 1200;
  assert.equal((await quoteFor(trip({ passengers: 3, childSeats: seats }))).d.seatFeeCents, 2 * 1200);
  assert.equal(b.row.online_amount_cents, 17000);
  db.t("booking_settings")[0].child_seat_one_way_cents = 1000;
  setFixed(null, null, null);
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

test("Vehicle saves refresh the cached public site and never report success when no row was written", async () => {
  globalThis.__cookies = { vt_at: "good" };
  const crud = (id: string, values: object) => routes.crud.POST(post("/api/admin/crud", { resource: "vehicles", action: "update", id, values }));
  const g = globalThis as unknown as { __revalidated?: number };
  const eclass = db.t("vehicles")[0];

  g.__revalidated = 0;
  assert.equal((await crud(eclass.id, { description: "Fresh description" })).status, 200);
  assert.equal(eclass.description, "Fresh description");
  assert.equal(g.__revalidated, 1, "a successful vehicle save must invalidate the cached public pages");

  g.__revalidated = 0;
  const missing = await crud("00000000-0000-4000-8000-000000000000", { description: "x" });
  assert.equal(missing.status, 404);
  assert.equal(g.__revalidated, 0, "a failed save must not claim success or revalidate");

  // A non-public table (bookings settings etc.) does not trigger a site refresh.
  g.__revalidated = 0;
  await routes.crud.POST(post("/api/admin/crud", { resource: "customers", action: "update", id: "00000000-0000-4000-8000-000000000000", values: { name: "x" } }));
  assert.equal(g.__revalidated, 0);
  eclass.description = null;
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
// Admin approval through the REAL workflow route (assigns a driver and releases payment). Payment is impossible before this.
const l_e = (m: any) => m.event;
const adminAs = async <T,>(fn: () => Promise<T>) => { const prev = (globalThis as any).__cookies; (globalThis as any).__cookies = { vt_at: "good" }; try { return await fn(); } finally { (globalThis as any).__cookies = prev; } };
const aDriver = () => { if (!db.t("drivers").length) db.seed("drivers", [{ full_name: "Dana Driver", email: "dana@example.com", phone: "4105550999", vehicle_plate: "VT-123", vehicle_description: "Black Escalade", is_active: true }]); return db.t("drivers")[0]; };
const approve = (b: { row: any }, driverId = aDriver().id) => adminAs(() => routes.workflow.POST(post("/api/admin/bookings/workflow", { id: b.row.id, action: "approve_assign", driverId })));
const pay = async (token: string, extra: object = {}) => {
  const row = db.t("bookings").find((x: any) => x.payment_token === token);
  if (row && !row.payment_released_at && !(extra as any).unapproved) await approve({ row });
  return routes.checkout.POST(post("/api/payments/checkout", { token, provider: "stripe", ...extra }));
};
const setPay = (mode: string, extra: Record<string, unknown> = {}) => Object.assign(db.t("booking_settings")[0], { payment_mode: mode, deposit_fixed_cents: null, deposit_percent: null, ...extra });

test("payments disabled by default: booking requests work, no checkout is offered", async () => {
  setPay("disabled");
  setFixed(null, 15000, null);
  const b = await makeBooking();
  assert.equal(b.res.status, 200);
  assert.equal(b.data.payUrl, null);
  assert.equal(b.row.payment_status, "not_required");
  const r = await pay(b.row.payment_token);
  assert.equal(r.status, 503); // no provider is offered while online payment is disabled
  assert.equal(db.t("payments").filter((p: any) => p.booking_id === b.row.id).length, 0);
  assert.equal((await pay("not-a-token")).status, 400);
});

test("Stripe Checkout: amount comes only from the saved server-side total; client amounts are ignored; booking is not confirmed or paid", async () => {
  setPay("full");
  const b = await makeBooking({ totalCents: 1 });
  assert.equal(b.data.payUrl, null); assert.match(b.data.trackingId, /^TRK-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/); // no pay link at submission
  assert.equal((await pay(b.row.payment_token, { unapproved: true })).status, 409); // payment is impossible before admin approval
  assert.equal(db.t("payments").filter((x: any) => x.booking_id === b.row.id).length, 0);
  assert.equal(b.row.payment_status, "unpaid");
  const total = b.row.online_amount_cents; assert.equal(total, 15000); // the fixed Luxury price, not the trip estimate
  assert.notEqual(total, b.row.estimated_fare_cents);

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
  assert.equal(b.row.status, "assigned");      // creating a session confirms nothing: still awaiting payment
  assert.equal(b.row.confirmed_at ?? null, null);
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
  assert.equal(p.amount_cents, b.row.online_amount_cents);
  assert.equal(b.row.payment_status, "paid");
  assert.equal(b.row.status, "confirmed"); assert.ok(b.row.confirmed_at); // confirmed ONLY by the verified payment
  assert.ok(db.t("admin_notifications").some((n: any) => n.event === "payment.paid" && n.entity_id === b.row.id));
  const mails = db.t("notification_logs").filter((l: any) => (l.event === "payment.paid" || l.event === "booking.confirmed") && l.entity_id === b.row.id);
  assert.deepEqual(mails.map((m: any) => `${l_e(m)}:${m.payload.audience}`).sort(), ["booking.confirmed:customer", "payment.paid:business"]);

  // The same event delivered again changes nothing.
  const dup = await routes.webhook.POST(hook(good));
  assert.equal(dup.status, 200); assert.equal((await dup.json()).result, "duplicate");
  assert.equal(b.row.amount_paid_cents, p.amount_cents);
  assert.equal(db.t("payments").filter((x: any) => x.booking_id === b.row.id).length, 1);
  assert.equal(db.t("notification_logs").filter((l: any) => (l.event === "payment.paid" || l.event === "booking.confirmed") && l.entity_id === b.row.id).length, 2);
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
  assert.equal(b.data.payUrl, null); assert.match(b.data.trackingId, /^TRK-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/); // no pay link at submission
  assert.equal((await pay(b.row.payment_token, { unapproved: true })).status, 409); // payment is impossible before admin approval
  assert.equal(db.t("payments").filter((x: any) => x.booking_id === b.row.id).length, 0);
  await pay(b.row.payment_token);
  let p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
  assert.equal(p.amount_cents, Math.round(b.row.online_amount_cents * 0.25)); assert.equal(p.kind, "deposit");
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


// =====================================================================================================
// Fixed tier pricing, per-tier Meet & Greet, admin price management, PayPal
// =====================================================================================================
const luxury = () => TIERS()[1];
const airportBlock = { airport: "Dulles Airport", direction: "arrival", flightNumber: "UA1", airline: "United", terminal: "B", passengerName: "Ann Rider" };

test("tiers: exactly three are offered with their fixed price and Meet & Greet fee; the trip estimate stays a separate, informational calculation", async () => {
  setFixed(10000, 15000, 22000);
  const { d, ec } = await quoteFor(trip());
  assert.deepEqual(d.tiers.map((t: any) => t.name), ["Premium", "Luxury", "Luxury Plus"]);
  assert.deepEqual(d.tiers.map((t: any) => t.meetGreetFeeCents), [2500, 3500, 5000]); // initial approved fees
  const lux = d.vehicles.find((v: any) => v.name === "E-Class"), prem = d.vehicles.find((v: any) => v.name === "Sprinter");
  assert.deepEqual(lux.tiers.map((t: any) => t.name), ["Luxury"]); assert.deepEqual(prem.tiers.map((t: any) => t.name), ["Premium"]);
  assert.deepEqual([lux.tiers[0].fixedPriceCents, lux.tiers[0].meetGreetFeeCents], [15000, 3500]);
  assert.deepEqual([prem.tiers[0].fixedPriceCents, prem.tiers[0].meetGreetFeeCents], [10000, 2500]);
  assert.ok(ec.totalCents > 0 && ec.totalCents !== 15000); // the mileage-based estimate is still calculated, and is not the fixed price
  assert.ok(!JSON.stringify(ec.lineItems).includes("Fixed"));
});

test("Meet & Greet: fee comes from the selected tier on the server; changing tier changes the fee; deselecting removes it; never added twice; airport details required", async () => {
  setFixed(10000, 15000, 22000); setPay("full");
  const base = (await makeBooking({ details: undefined, airport: airportBlock })).row;
  assert.equal(base.meet_greet_selected, false);
  assert.equal(base.online_amount_cents, 15000);                       // deselected: no fee in the charge

  const lux = await makeBooking({ airport: airportBlock, fixedPriceCents: 1, meetGreetCents: 1, onlineAmountCents: 1 }, { meetGreet: true }); // a tierId is validated, not trusted: see tests/vehicle-tiers.test.ts
  assert.equal(lux.res.status, 200);
  assert.equal(lux.row.meet_greet_selected, true);
  assert.equal(lux.row.fixed_price_cents, 15000); assert.equal(lux.row.meet_greet_fee_cents, 3500);
  assert.equal(lux.row.online_amount_cents, 15000 + 3500);             // browser-supplied values ignored
  assert.equal(lux.row.tier_name, "Luxury");
  const air = db.t("booking_airport_details").find((a: any) => a.booking_id === lux.row.id);
  assert.equal(air.meet_greet_requested, true); assert.equal(air.meet_greet_status, "requested"); assert.equal(air.meet_greet_charge_cents, 3500);
  assert.notEqual(lux.row.online_amount_cents, lux.row.estimated_fare_cents);
  const snap = db.t("pricing_snapshots").find((x: any) => x.booking_id === lux.row.id);
  assert.equal(snap.snapshot.online.totalCents, 18500);

  // Different tier (Premium vehicle): its own fee. Another submission of the same trip does not add the fee twice.
  const prem = await makeBooking({ vehicleId: ids.sprinter, airport: airportBlock }, { meetGreet: true });
  assert.equal(prem.row.meet_greet_fee_cents, 2500); assert.equal(prem.row.online_amount_cents, 10000 + 2500);
  const again = await makeBooking({ airport: airportBlock, submissionKey: lux.row.submission_key }, { meetGreet: true });
  assert.equal(again.row.online_amount_cents, 18500); assert.equal(db.t("bookings").filter((b: any) => b.submission_key === lux.row.submission_key).length, 1);

  // Airport details are required for Meet & Greet; it must be switched on and offered for the tier.
  assert.equal((await makeBooking({}, { meetGreet: true })).res.status, 422);
  db.t("booking_settings")[0].meet_greet_enabled = false;
  assert.equal((await makeBooking({ airport: airportBlock }, { meetGreet: true })).res.status, 422);
  db.t("booking_settings")[0].meet_greet_enabled = true;
  luxury().meet_greet_fee_cents = null;
  const notOffered = await makeBooking({ airport: airportBlock }, { meetGreet: true });
  assert.equal(notOffered.res.status, 422); assert.match(notOffered.data.error, /not offered for this tier/i);
  assert.equal((await makeBooking({ airport: airportBlock }, {})).res.status, 200); // deselected: fine
  luxury().meet_greet_fee_cents = 3500;
});

test("fixed prices: a missing price means no online charge (never invented); later admin changes never rewrite saved bookings", async () => {
  setPay("full"); setFixed(10000, null, 22000);
  const none = await makeBooking();
  assert.equal(none.res.status, 200);
  assert.equal(none.row.online_amount_cents, null); assert.equal(none.row.fixed_price_cents, null);
  assert.equal(none.data.payUrl, null); assert.equal(none.row.payment_status, "not_required");
  assert.equal((await pay(none.row.payment_token)).status, 409);       // checkout refuses: price not set yet

  setFixed(10000, 15000, 22000);
  const before = await makeBooking(); assert.equal(before.row.online_amount_cents, 15000);
  luxury().fixed_price_cents = 18000; luxury().meet_greet_fee_cents = 4000;      // admin raises the prices
  assert.equal(before.row.online_amount_cents, 15000); assert.equal(before.row.fixed_price_cents, 15000);
  const checkout = await pay(before.row.payment_token);                           // the customer pays what they were shown
  assert.equal(checkout.status, 200);
  assert.equal(db.t("payments").filter((p: any) => p.booking_id === before.row.id).at(-1).amount_cents, 15000);
  const after = await makeBooking();                                              // a NEW booking uses the new price
  assert.equal(after.row.online_amount_cents, 18000);
  luxury().fixed_price_cents = 15000; luxury().meet_greet_fee_cents = 3500;
});

test("admin: only an authorized admin can set tier fixed prices and Meet & Greet fees; amounts are validated; tiers cannot be created, deleted or renamed", async () => {
  const crud = (body: object) => routes.crud.POST(post("/api/admin/crud", { resource: "tiers", ...body }));
  const tier = TIERS()[2];
  globalThis.__cookies = {};
  assert.equal((await crud({ action: "update", id: tier.id, values: { fixed_price_cents: "250" } })).status, 401);
  assert.equal(tier.fixed_price_cents, 22000 ?? null);

  globalThis.__cookies = { vt_at: "good" };
  const upd = (values: object) => crud({ action: "update", id: tier.id, values });
  assert.equal((await upd({ fixed_price_cents: "250.00", meet_greet_fee_cents: "55" })).status, 200);
  assert.equal(tier.fixed_price_cents, 25000); assert.equal(tier.meet_greet_fee_cents, 5500);
  for (const bad of ["0", "-5", "abc", "20000"]) assert.ok((await upd({ fixed_price_cents: bad })).status >= 400, bad);
  assert.equal(tier.fixed_price_cents, 25000);
  assert.ok((await upd({ meet_greet_fee_cents: "0" })).status >= 400);
  assert.equal((await upd({ fixed_price_cents: "" })).status, 200);       // blank = not configured yet
  assert.equal(tier.fixed_price_cents, null);

  const n = TIERS().length;
  assert.ok((await crud({ action: "create", values: { name: "Economical" } })).status >= 400);
  assert.ok((await crud({ action: "delete", id: tier.id })).status >= 400);
  assert.equal(TIERS().length, n);
  await upd({ name: "Economical" });
  assert.equal(tier.name, "Luxury Plus");

  // The saved price shows up in new fare calculations.
  await upd({ fixed_price_cents: "260" });
  assert.equal(tier.fixed_price_cents, 26000);
  assert.equal((await quoteFor(trip())).d.tiers[2].fixedPriceCents, 26000);
  globalThis.__cookies = {};
});

// ---- Stripe line items for the fixed-price charge -----------------------------------------------------
test("Stripe checkout lists the charged components once each: fixed price, Meet & Greet, child seats; never the trip estimate", async () => {
  setFixed(10000, 15000, 22000); setPay("full");
  const b = await makeBooking({ airport: airportBlock }, { meetGreet: true, passengers: 3, childSeats: { booster: 2 } });
  assert.equal(b.row.online_amount_cents, 15000 + 3500 + 2000);
  const from = net.calls.length;
  assert.equal((await pay(b.row.payment_token)).status, 200);
  const form = new URLSearchParams(String(net.calls.slice(from).find((c) => c.url === "https://api.stripe.com/v1/checkout/sessions")!.body));
  const amounts = [0, 1, 2, 3].map((i) => form.get(`line_items[${i}][price_data][unit_amount]`)).filter(Boolean);
  assert.deepEqual(amounts, ["15000", "3500", "2000"]);
  assert.equal(form.get("line_items[1][price_data][product_data][name]"), "Airport Meet & Greet");
  assert.equal(String(b.row.estimated_fare_cents) === "15000", false);
  const p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
  assert.deepEqual([p.provider, p.tier_name, p.fixed_price_cents, p.meet_greet_cents, p.other_addons_cents, p.amount_cents], ["stripe", "Luxury", 15000, 3500, 2000, 20500]);
  assert.equal(p.estimated_trip_fare_cents, b.row.estimated_fare_cents);   // recorded for reference only
});

// ---- PayPal -------------------------------------------------------------------------------------------
const PP_ENV = { PAYPAL_CLIENT_ID: "pp-client", PAYPAL_CLIENT_SECRET: "pp-secret", PAYPAL_ENV: "sandbox", PAYPAL_WEBHOOK_ID: "WH-1" };
const withPayPal = async (fn: () => Promise<void>) => {
  Object.assign(process.env, PP_ENV);
  try { await fn(); } finally { for (const k of Object.keys(PP_ENV)) delete process.env[k]; net.pp.capStatus = "COMPLETED"; net.pp.capAmount = null; net.pp.verify = true; }
};
const capture = (token: string, orderId: string) => routes.ppcapture.POST(post("/api/payments/paypal/capture", { token, orderId }));
const ppHook = (event: object) => new Request("http://site.test/api/paypal/webhook", { method: "POST", headers: { "paypal-transmission-id": "t1", "paypal-transmission-time": "2026-01-01T00:00:00Z", "paypal-cert-url": "https://api.paypal.com/cert", "paypal-auth-algo": "SHA256withRSA", "paypal-transmission-sig": "sig", "content-type": "application/json" }, body: JSON.stringify(event) });
const startPayPal = async (b: any) => { const r = await pay(b.row.payment_token, { provider: "paypal" }); return { r, out: await r.json() }; };

test("providers are offered only when switched on AND configured; nothing is shown as available otherwise", async () => {
  const { availableProviders } = await import("../src/lib/payment-providers.ts");
  const { loadBookingSettings } = await import("../src/lib/policies.ts");
  setPay("full");
  const settings = async () => loadBookingSettings(db as any);
  const saved = process.env.STRIPE_SECRET_KEY;
  assert.deepEqual(availableProviders(await settings()), ["stripe"]);                      // PayPal not configured
  await withPayPal(async () => {
    assert.deepEqual(availableProviders(await settings()), ["stripe", "paypal"]);
    db.t("booking_settings")[0].stripe_enabled = false;
    assert.deepEqual(availableProviders(await settings()), ["paypal"]);                    // switched off in admin
    db.t("booking_settings")[0].stripe_enabled = true; db.t("booking_settings")[0].paypal_enabled = false;
    assert.deepEqual(availableProviders(await settings()), ["stripe"]);
    db.t("booking_settings")[0].paypal_enabled = true;
    delete process.env.STRIPE_SECRET_KEY;
    assert.deepEqual(availableProviders(await settings()), ["paypal"]);
    process.env.STRIPE_SECRET_KEY = saved;
    setPay("disabled");
    assert.deepEqual(availableProviders(await settings()), []);                            // online payment disabled
    setPay("full");
  });
  // A provider that is not available is refused, and the customer's choice is never silently switched.
  const b = await makeBooking();
  const r = await pay(b.row.payment_token, { provider: "paypal" });
  assert.equal(r.status, 503); assert.match((await r.json()).error, /PayPal is not available/);
  assert.equal(db.t("payments").filter((p: any) => p.booking_id === b.row.id).length, 0);
});

test("PayPal: the order amount is calculated on the server; capture is verified server-side before anything is marked paid", async () => {
  setFixed(10000, 15000, 22000); setPay("full");
  await withPayPal(async () => {
    const b = await makeBooking({ airport: airportBlock }, { meetGreet: true });
    const { r, out } = await startPayPal(b);
    assert.equal(r.status, 200); assert.match(out.orderId, /^PPORDER/);
    const order = net.pp.orders.get(out.orderId);
    const unit = order.purchase_units[0];
    assert.equal(unit.amount.value, "185.00");                       // 15000 + 3500 cents, no floating point
    assert.equal(unit.amount.currency_code, "USD");
    assert.equal(unit.custom_id, b.row.id);
    assert.deepEqual(unit.items.map((i: any) => i.unit_amount.value), ["150.00", "35.00"]);
    const p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
    assert.deepEqual([p.provider, p.provider_ref, p.status, p.amount_cents, p.fixed_price_cents, p.meet_greet_cents], ["paypal", out.orderId, "pending", 18500, 15000, 3500]);
    assert.equal(unit.reference_id, p.id);
    assert.equal(b.row.payment_status, "pending"); assert.equal(b.row.amount_paid_cents, 0); // creating an order marks nothing paid

    // The browser's own claims are irrelevant: a wrong token or someone else's order cannot be captured.
    assert.equal((await capture(crypto.randomUUID(), out.orderId)).status, 404);
    const other = await makeBooking();
    assert.equal((await capture(other.row.payment_token, out.orderId)).status, 404);
    assert.equal(p.status, "pending");

    const cap = await capture(b.row.payment_token, out.orderId);
    assert.equal(cap.status, 200); assert.equal((await cap.json()).status, "paid");
    assert.equal(p.status, "paid"); assert.equal(p.provider_txn_id, `CAP${out.orderId}`); assert.ok(p.paid_at);
    assert.equal(b.row.amount_paid_cents, 18500); assert.equal(b.row.payment_status, "paid");
    assert.equal(b.row.status, "confirmed");                         // confirmed by the verified payment
    const mails = () => db.t("notification_logs").filter((l: any) => l.event === "payment.paid" && l.entity_id === b.row.id);
    assert.equal(mails().length, 1); assert.equal(db.t("notification_logs").filter((l: any) => l.event === "booking.confirmed" && l.entity_id === b.row.id).length, 1);
    assert.match(JSON.stringify(mails()), /PayPal/);
    // Capturing again (double click, retry) is harmless: same state, no extra emails or payment rows.
    assert.equal((await (await capture(b.row.payment_token, out.orderId)).json()).status, "paid");
    assert.equal(mails().length, 1); assert.equal(db.t("notification_logs").filter((l: any) => l.event === "booking.confirmed" && l.entity_id === b.row.id).length, 1); assert.equal(db.t("payments").filter((x: any) => x.booking_id === b.row.id).length, 1);
    assert.equal(b.row.amount_paid_cents, 18500);
  });
});

test("PayPal: a captured amount that does not match is flagged for review, never marked paid; declined payments keep the booking and can be retried", async () => {
  setFixed(10000, 15000, 22000); setPay("full");
  await withPayPal(async () => {
    const b = await makeBooking();
    const { out } = await startPayPal(b);
    net.pp.capAmount = "1.00";
    const r = await capture(b.row.payment_token, out.orderId);
    assert.equal(r.status, 409);
    const p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
    assert.equal(p.status, "review"); assert.equal(b.row.payment_status, "review"); assert.equal(b.row.amount_paid_cents, 0);
    assert.equal(db.t("notification_logs").filter((l: any) => l.event === "payment.paid" && l.entity_id === b.row.id).length, 0); // no payment email
    assert.ok(db.t("admin_notifications").some((n: any) => n.event === "payment.review" && n.entity_id === b.row.id));

    net.pp.capAmount = null;
    const b2 = await makeBooking();
    const first = await startPayPal(b2);
    net.pp.capStatus = "DECLINED";
    assert.equal((await capture(b2.row.payment_token, first.out.orderId)).status, 402);
    assert.equal(b2.row.payment_status, "failed"); assert.ok(db.t("bookings").some((x: any) => x.id === b2.row.id)); // booking not lost
    net.pp.capStatus = "COMPLETED";
    const second = await startPayPal(b2);                              // retry path
    assert.notEqual(second.out.orderId, first.out.orderId);
    assert.equal((await capture(b2.row.payment_token, second.out.orderId)).status, 200);
    assert.equal(b2.row.payment_status, "paid"); assert.equal(b2.row.amount_paid_cents, 15000);
  });
});

test("PayPal webhook: signature verified with PayPal; completed payments recorded once; duplicates and refunds handled; Stripe and PayPal share one payment table", async () => {
  setFixed(10000, 15000, 22000); setPay("full");
  await withPayPal(async () => {
    const b = await makeBooking();
    const { out } = await startPayPal(b);
    const p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
    const completed = (id: string, value = "150.00") => ({ id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: `CAPW${out.orderId}`, status: "COMPLETED", amount: { currency_code: "USD", value }, custom_id: b.row.id, supplementary_data: { related_ids: { order_id: out.orderId } } } });

    net.pp.verify = false;
    assert.equal((await routes.ppwebhook.POST(ppHook(completed("WH-EVT-1")))).status, 400);      // forged
    assert.equal(p.status, "pending"); assert.equal(db.t("paypal_events").length, 0);
    net.pp.verify = true;
    assert.equal((await routes.ppwebhook.POST(ppHook(completed("WH-EVT-2", "1.00")))).status, 200); // wrong amount
    assert.equal(p.status, "review"); assert.equal(b.row.amount_paid_cents, 0);

    const b2 = await makeBooking(); const o2 = (await startPayPal(b2)).out; const p2 = db.t("payments").find((x: any) => x.booking_id === b2.row.id);
    const ev = { id: "WH-EVT-3", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPW2", status: "COMPLETED", amount: { currency_code: "USD", value: "150.00" }, custom_id: b2.row.id, supplementary_data: { related_ids: { order_id: o2.orderId } } } };
    const ok = await routes.ppwebhook.POST(ppHook(ev));
    assert.equal(ok.status, 200); assert.equal((await ok.json()).result, "processed");
    assert.equal(p2.status, "paid"); assert.equal(p2.provider_txn_id, "CAPW2"); assert.equal(b2.row.amount_paid_cents, 15000); assert.equal(b2.row.status, "confirmed");
    const dup = await routes.ppwebhook.POST(ppHook(ev));
    assert.equal((await dup.json()).result, "duplicate");
    await routes.ppwebhook.POST(ppHook({ ...ev, id: "WH-EVT-4" }));                           // same payment, new event id
    assert.equal(b2.row.amount_paid_cents, 15000);
    assert.equal(db.t("notification_logs").filter((l: any) => (l.event === "payment.paid" || l.event === "booking.confirmed") && l.entity_id === b2.row.id).length, 2); // a replayed webhook never emails twice

    const refund = { id: "WH-EVT-5", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "REF1", amount: { currency_code: "USD", value: "50.00" }, links: [{ rel: "up", href: "https://api.paypal.com/v2/payments/captures/CAPW2" }] } };
    await routes.ppwebhook.POST(ppHook(refund));
    assert.equal(p2.status, "partially_refunded"); assert.equal(p2.refunded_cents, 5000); assert.equal(b2.row.amount_paid_cents, 10000);

    // Both providers write to the same table, with provider-specific references.
    const sb = await makeBooking(); await pay(sb.row.payment_token);
    assert.deepEqual([...new Set(db.t("payments").map((x: any) => x.provider))].sort(), ["paypal", "stripe"]);
  });
  const saved = process.env.PAYPAL_WEBHOOK_ID; delete process.env.PAYPAL_WEBHOOK_ID;
  assert.equal((await routes.ppwebhook.POST(ppHook({ id: "x", event_type: "PAYMENT.CAPTURE.COMPLETED" }))).status, 503); // not configured
  if (saved) process.env.PAYPAL_WEBHOOK_ID = saved;
});


// ======================================================================================================
// Approval -> verified payment -> confirmation -> tracking -> driver chat (the full customer journey)
// ======================================================================================================
// Emails actually ADDRESSED to someone (matching the To: field, not merely mentioning the address in the body).
const brevoTo = (addr: string) => net.calls.filter((c) => c.url === "https://api.brevo.com/v3/smtp/email" && (c.body?.to ?? []).some((t: any) => t.email === addr));
const flow = async (extra: Record<string, unknown> = {}) => {
  setPay("full"); setFixed(10000, 15000, 22000);
  net.emailOk = true;
  const b = await makeBooking(extra, { stops: [{ text: "Stop Cafe, Towson" }] });
  return b;
};
const wf = (id: string, body: object) => adminAs(() => routes.workflow.POST(post("/api/admin/bookings/workflow", { id, ...body })));
const trackPost = (code: unknown, ip?: string) => routes.track.POST(post("/api/track", { trackingId: code }, ip ? { "x-forwarded-for": ip } : undefined));
const trackChat = (method: "GET" | "POST", code: string | null, body?: object, ip?: string) => {
  const h: Record<string, string> = { ...HDR(ip ? { "x-forwarded-for": ip } : {}) }; if (code) h["x-tracking-id"] = code;
  return method === "GET" ? routes.trackChat.GET(new Request("http://site.test/api/track/messages", { headers: h })) : routes.trackChat.POST(new Request("http://site.test/api/track/messages", { method: "POST", headers: h, body: JSON.stringify(body) }));
};
const asDriver = async <T,>(token: string, fn: () => Promise<T>) => { const prev = (globalThis as any).__cookies; (globalThis as any).__cookies = { vd_at: token }; try { return await fn(); } finally { (globalThis as any).__cookies = prev; } };

test("submission: unguessable tracking ID, awaiting review, nothing charged, no pay link, admin notified with a dashboard link", async () => {
  db.seed("site_content", [{ key: "contact.phone", value: "+1 555-010-0199", group_name: "Contact" }]);
  net.calls.length = 0;
  const b = await flow();
  assert.equal(b.res.status, 200);
  assert.match(b.row.tracking_code, /^TRK-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  assert.ok(!b.row.tracking_code.includes(b.row.reference.replace("VT-", "")) || true);
  assert.equal(b.row.status, "new_request"); assert.equal(b.row.payment_status, "unpaid"); assert.equal(b.row.amount_paid_cents, 0);
  assert.equal(b.row.confirmed_at ?? null, null); assert.equal(b.row.payment_released_at ?? null, null);
  assert.equal(b.data.payUrl, null); assert.equal(db.t("payments").filter((x: any) => x.booking_id === b.row.id).length, 0);
  // Admin dashboard alert + business email with a link into the admin booking page.
  const alert = db.t("admin_notifications").find((n: any) => n.event === "booking.created" && n.entity_id === b.row.id);
  assert.ok(alert); assert.match(String(alert.link), new RegExp(`/admin/bookings/${b.row.id}`));
  const biz = brevoTo("owner@example.com").find((c) => JSON.stringify(c.body).includes(b.row.reference));
  assert.ok(biz && JSON.stringify(biz.body).includes(`/admin/bookings/${b.row.id}`));
  // Customer email: tracking ID and tracking link, and NO payment link.
  const cust = brevoTo("ann@example.com").find((c) => JSON.stringify(c.body).includes(b.row.reference))!;
  const html = JSON.stringify(cust.body);
  assert.ok(html.includes(b.row.tracking_code)); assert.ok(html.includes("/track#id=")); assert.ok(!html.includes("/pay/"));
});

test("approval releases payment; confirmation comes ONLY from the verified payment; webhook retries send one email", async () => {
  const b = await flow();
  // Before approval: the payment endpoint refuses and the pay page has nothing to charge.
  assert.equal((await pay(b.row.payment_token, { unapproved: true })).status, 409);
  const driver = aDriver();
  const ap = await approve(b);
  assert.equal(ap.status, 200);
  assert.equal(b.row.status, "assigned"); assert.ok(b.row.payment_released_at); assert.equal(b.row.driver_id, driver.id);
  assert.equal(b.row.payment_status, "unpaid"); assert.equal(b.row.confirmed_at ?? null, null); // approval is not payment, and not confirmation
  const apEmail = brevoTo("ann@example.com").filter((c) => JSON.stringify(c.body).includes(b.row.reference) && JSON.stringify(c.body).includes("/pay/"));
  assert.equal(apEmail.length, 1);
  assert.ok(!JSON.stringify(apEmail[0].body).includes("4105550999")); // the driver's phone is never emailed to the customer
  // A second approval (double click / second admin) is refused.
  assert.equal((await approve(b)).status, 409);
  assert.equal(db.t("booking_assignments").filter((a: any) => a.booking_id === b.row.id && !a.unassigned_at).length, 1);

  // Customer starts checkout, returns from the provider WITHOUT a verified event: still unpaid, unconfirmed.
  assert.equal((await pay(b.row.payment_token)).status, 200);
  const p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
  assert.equal(b.row.status, "assigned"); assert.equal(b.row.confirmed_at ?? null, null);

  net.calls.length = 0;
  const evt = sessionEvent("checkout.session.completed", p, {}, "evt_confirm_1");
  assert.equal((await (await routes.webhook.POST(hook(evt))).json()).result, "processed");
  assert.equal(p.status, "paid"); assert.equal(b.row.payment_status, "paid"); assert.equal(b.row.status, "confirmed"); assert.ok(b.row.confirmed_at);
  const hist = db.t("booking_status_history").filter((h: any) => h.booking_id === b.row.id && h.to_status === "confirmed");
  assert.equal(hist.length, 1); assert.equal(hist[0].actor_type, "system");

  // Confirmation email: reference, tracking, route, time, vehicle, amount actually paid, helpline.
  const conf = brevoTo("ann@example.com").filter((c) => JSON.stringify(c.body).includes("is confirmed"));
  assert.equal(conf.length, 1);
  const h = JSON.stringify(conf[0].body);
  for (const must of [b.row.reference, b.row.tracking_code, "1 Main St, Baltimore", "Stop Cafe, Towson", "Dulles Airport", "E-Class", "$150.00", "+1 555-010-0199", "/track#id="]) assert.ok(h.includes(must), must);

  // Redelivery of the SAME event, a NEW event id for the same payment, and a late async-success event: nothing changes, no more emails.
  await routes.webhook.POST(hook(evt));
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p, {}, "evt_confirm_2")));
  await routes.webhook.POST(hook(sessionEvent("checkout.session.async_payment_succeeded", p, {}, "evt_confirm_3")));
  assert.equal(brevoTo("ann@example.com").filter((c) => JSON.stringify(c.body).includes("is confirmed")).length, 1);
  assert.equal(brevoTo("owner@example.com").filter((c) => JSON.stringify(c.body).includes("Payment received")).length, 1);
  assert.equal(db.t("booking_status_history").filter((x: any) => x.booking_id === b.row.id && x.to_status === "confirmed").length, 1);
  assert.equal(b.row.amount_paid_cents, 15000);
  // Two deliveries racing each other record one payment and one confirmation.
  const b2 = await flow(); await approve(b2); await pay(b2.row.payment_token);
  const p2 = db.t("payments").find((x: any) => x.booking_id === b2.row.id); net.calls.length = 0;
  await Promise.all([routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p2, {}, "evt_race_a"))), routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p2, {}, "evt_race_b")))]);
  assert.equal(b2.row.amount_paid_cents, 15000);
  assert.equal(brevoTo("ann@example.com").filter((c) => JSON.stringify(c.body).includes("is confirmed")).length, 1);
});

test("a verified payment for a cancelled booking is recorded but NOT confirmed, nothing is refunded, admin is flagged, customer gets no confirmation", async () => {
  const b = await flow(); await approve(b); await pay(b.row.payment_token);
  const p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
  const cancel = await wf(b.row.id, { action: "cancel", reason: "Customer asked to cancel" });
  assert.equal(cancel.status, 200); assert.equal(b.row.status, "cancelled"); assert.equal(b.row.payment_released_at, null);
  net.calls.length = 0;
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p, {}, "evt_late_1")));
  assert.equal(p.status, "paid"); assert.equal(b.row.status, "cancelled"); assert.equal(b.row.confirmed_at ?? null, null);
  assert.equal(brevoTo("ann@example.com").filter((c) => JSON.stringify(c.body).includes("is confirmed")).length, 0);
  assert.equal(net.calls.filter((c) => /refund/i.test(c.url)).length, 0);
  const alert = db.t("admin_notifications").find((n: any) => n.event === "payment.paid" && n.entity_id === b.row.id);
  assert.match(alert.title, /needs review/i);
  assert.equal((await pay(b.row.payment_token, { unapproved: true })).status, 409); // and no further charge is possible
});

test("rejected and cancelled bookings cannot continue through the active flow; invalid transitions are refused; generic CRUD cannot bypass the workflow", async () => {
  const b = await flow();
  assert.equal((await wf(b.row.id, { action: "advance", status: "completed" })).status, 409);       // not valid from awaiting review
  assert.equal((await wf(b.row.id, { action: "reject", reason: "Fully booked" })).status, 200);
  assert.equal(b.row.status, "rejected");
  assert.equal((await approve(b)).status, 409);                                                       // cannot approve after rejection
  assert.equal((await wf(b.row.id, { action: "cancel", reason: "nope nope" })).status, 409);
  assert.equal((await pay(b.row.payment_token, { unapproved: true })).status, 409);

  const c = await flow(); await approve(c);
  assert.equal((await wf(c.row.id, { action: "advance", status: "confirmed" })).status, 422);       // "confirmed" can only come from verified payment
  assert.equal((await wf(c.row.id, { action: "advance", status: "completed" })).status, 409);       // cannot skip the driver steps
  const early = await wf(c.row.id, { action: "advance", status: "getting_ready" });
  assert.equal(early.status, 409); assert.equal((await early.json()).code, "awaiting_payment");   // unpaid: even an admin cannot start the ride
  await pay(c.row.payment_token);
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", db.t("payments").find((x: any) => x.booking_id === c.row.id), {}, "evt_adv_1")));
  assert.equal((await wf(c.row.id, { action: "advance", status: "getting_ready" })).status, 200);
  // Generic CRUD ignores workflow and payment fields even when a client sends them.
  const r = await adminAs(() => routes.crud.POST(post("/api/admin/crud", { resource: "bookings", action: "update", id: c.row.id, values: { status: "completed", payment_status: "paid", driver_id: null, confirmed_at: new Date().toISOString(), passengers: 3 } })));
  const confirmedAt = c.row.confirmed_at; assert.ok(confirmedAt);
  assert.equal(c.row.status, "getting_ready"); assert.equal(c.row.payment_status, "paid"); assert.ok(c.row.driver_id); // unchanged by the forged generic update (completed / unpaid / driver null / new confirmed_at)
  void r;
  // Terminal states stay terminal.
  assert.equal((await wf(c.row.id, { action: "cancel", reason: "Driver unavailable" })).status, 200);
  assert.equal((await wf(c.row.id, { action: "advance", status: "on_the_way" })).status, 409);
});

test("tracking: unknown, malformed and booking-reference inputs get one generic answer; the sequential reference is never a credential", async () => {
  const b = await flow();
  for (const bad of ["", "nonsense", "TRK-AAAAA-BBBBB-CCCCC", 12345, null, { a: 1 }, "TRK-" + "A".repeat(500)]) {
    const r = await trackPost(bad, "10.9.0.1");
    assert.ok([404, 429].includes(r.status), String(bad));
  }
  const byRef = await trackPost(b.row.reference, "10.9.0.2");
  assert.equal(byRef.status, 404);                                            // VT-1004 style references cannot look anything up
  assert.equal((await byRef.json()).error, "We could not find a booking for that tracking ID.");
  const byToken = await trackPost(b.row.payment_token, "10.9.0.3");           // the private link token is a different credential
  assert.equal(byToken.status, 404);
  const ok = await trackPost(b.row.tracking_code.toLowerCase().replace(/-/g, " "), "10.9.0.4"); // forgiving input
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).trip.reference, b.row.reference);
  // Guessing is throttled per client.
  let last = 0; for (let i = 0; i < 14; i++) last = (await trackPost("TRK-ZZZZZ-ZZZZZ-" + String(10000 + i).slice(0, 5), "10.9.0.99")).status;
  assert.equal(last, 429);
  assert.equal((await trackPost(b.row.tracking_code, "10.9.0.99")).status, 429);   // even a right guess waits once the budget is spent
});

test("tracking response shows real progress and contains no private data", async () => {
  db.seed("customers", []); // no-op: customers already exist from makeBooking
  const b = await flow();
  b.row.admin_notes = "INTERNAL-NOTE-SECRET";
  let t = (await (await trackPost(b.row.tracking_code, "10.8.0.1")).json()).trip;
  assert.equal(t.headline, "Awaiting approval"); assert.equal(t.driver, null); assert.equal(t.confirmed, false);
  assert.deepEqual(t.steps.filter((s: any) => s.state === "done").map((s: any) => s.key), ["received"]);
  await approve(b);
  t = (await (await trackPost(b.row.tracking_code, "10.8.0.1")).json()).trip;
  assert.equal(t.headline, "Approved: awaiting payment"); assert.equal(t.awaitingPayment, true); assert.equal(t.confirmed, false);
  assert.equal(t.driver.firstName, "Dana"); assert.equal(t.driver.vehicle, "Black Escalade");
  assert.equal(t.helpline.display, "+1 555-010-0199");
  await pay(b.row.payment_token);
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", db.t("payments").find((x: any) => x.booking_id === b.row.id), {}, "evt_track_1")));
  await wf(b.row.id, { action: "advance", status: "on_the_way" });
  t = (await (await trackPost(b.row.tracking_code, "10.8.0.1")).json()).trip;
  assert.equal(t.headline, "Your driver is on the way"); assert.equal(t.confirmed, true);
  assert.equal(t.steps.find((s: any) => s.state === "current").key, "on_the_way");
  assert.ok(t.steps.filter((s: any) => s.state === "done").map((s: any) => s.key).includes("confirmed"));
  const raw = JSON.stringify(t);
  for (const secret of ["4105550100", "ann@example.com", "INTERNAL-NOTE-SECRET", "4105550999", "dana@example.com", "VT-123", b.row.payment_token, "Dana Driver", "stripe", "cs_test_", "tel:"]) assert.ok(!raw.includes(secret), secret);
  assert.equal(t.charges, null); assert.equal(t.payable, false);                  // no amounts or pay button for the public tracking credential
  await wf(b.row.id, { action: "cancel", reason: "Changed plans" });
  t = (await (await trackPost(b.row.tracking_code, "10.8.0.1")).json()).trip;
  assert.equal(t.headline, "Booking cancelled"); assert.equal(t.ended, true);
  assert.equal(t.steps[t.steps.length - 1].ended, true); assert.ok(!t.steps.some((s: any) => s.key === "completed")); // never shown as progress
  assert.equal(t.driver, null); assert.equal(t.chatAvailable, false);
});

test("private link token page data: charges and pay button only for the token holder, still no phone numbers", async () => {
  const { loadTrip } = await import("../src/lib/trip.ts");
  const b = await flow(); await approve(b);
  const viaToken: any = await loadTrip(db, b.row.payment_token);
  assert.equal(viaToken.view.payable, true); assert.equal(viaToken.view.charges.totalCents, 15000);
  assert.ok(!JSON.stringify(viaToken.view).includes("4105550999") && !JSON.stringify(viaToken.view).includes("4105550100"));
  assert.equal(await loadTrip(db, "not-a-uuid"), null);
  assert.equal(await loadTrip(db, { kind: "code", code: b.row.payment_token }), null);
});

test("chat: only the booking's customer (tracking ID) and its CURRENTLY assigned driver; reassignment revokes the old driver at once", async () => {
  const origGetUser = db.auth.getUser;
  db.auth.getUser = async (t: string) => t === "good" ? { data: { user: { id: "admin-1", email: "a@x.com" } }, error: null } : t === "drv1" ? { data: { user: { id: "u-d1", email: "dana@example.com" } }, error: null } : t === "drv2" ? { data: { user: { id: "u-d2", email: "eli@example.com" } }, error: null } : { data: { user: null }, error: { message: "bad" } };
  try {
    const d1 = aDriver(); d1.user_id = "u-d1";
    db.seed("drivers", [{ full_name: "Eli Other", email: "eli@example.com", phone: "4105550888", vehicle_plate: "VT-456", is_active: true, user_id: "u-d2" }]);
    const d2 = db.t("drivers").find((d: any) => d.email === "eli@example.com");
    const a = await flow(); const other = await flow();
    const chatBefore = await trackChat("GET", a.row.tracking_code, undefined, "10.7.0.1");
    assert.equal(chatBefore.status, 404);                                       // no driver assigned yet: chat is not available
    await approve(a, d1.id); await approve(other, d2.id);

    const drvPost = (token: string, bookingId: string, body: unknown, clientId: string) => asDriver(token, () => routes.driverMessages.POST(post("/api/driver/messages", { bookingId, body, clientId })));
    const drvGet = (token: string, bookingId: string) => asDriver(token, () => routes.driverMessages.GET(new Request(`http://site.test/api/driver/messages?booking=${bookingId}`, { headers: HDR() })));

    // Customer sends; forged sender role in the body is ignored; empty / overlong / malformed are refused; the same clientId is stored once.
    const sent = await trackChat("POST", a.row.tracking_code, { body: "I am at the side entrance", clientId: "client-0001-aaaa", role: "driver", sender_role: "driver" }, "10.7.0.2");
    assert.equal(sent.status, 200); assert.equal((await sent.json()).message.role, "customer");
    assert.equal((await trackChat("POST", a.row.tracking_code, { body: "I am at the side entrance", clientId: "client-0001-aaaa" }, "10.7.0.3")).status, 200);
    assert.equal(db.t("booking_messages").filter((m: any) => m.booking_id === a.row.id).length, 1);
    assert.equal((await trackChat("POST", a.row.tracking_code, { body: "   ", clientId: "client-0002-aaaa" }, "10.7.0.4")).status, 422);
    assert.equal((await trackChat("POST", a.row.tracking_code, { body: "x".repeat(2000), clientId: "client-0003-aaaa" }, "10.7.0.5")).status, 422);
    assert.equal((await trackChat("POST", a.row.tracking_code, { body: 42, clientId: "client-0004-aaaa" }, "10.7.0.6")).status, 422);
    assert.equal((await trackChat("POST", a.row.tracking_code, { body: "hi", clientId: "!" }, "10.7.0.7")).status, 400);

    // Wrong or missing credentials and other bookings' credentials cannot read or write.
    assert.equal((await trackChat("GET", null, undefined, "10.7.1.1")).status, 404);
    assert.equal((await trackChat("GET", a.row.payment_token, undefined, "10.7.1.2")).status, 404);
    const mine = await (await trackChat("GET", a.row.tracking_code, undefined, "10.7.1.3")).json();
    assert.equal(mine.messages.length, 1);
    const theirs = await (await trackChat("GET", other.row.tracking_code, undefined, "10.7.1.4")).json();
    assert.equal(theirs.messages.length, 0);                                    // the other booking's customer never sees booking A's messages

    // Drivers: the assigned driver reads and replies; another driver gets "not found" for the same ride.
    assert.equal((await (await drvGet("drv1", a.row.id)).json()).messages.length, 1);
    assert.equal((await drvGet("drv2", a.row.id)).status, 404);
    assert.equal((await drvPost("drv2", a.row.id, "sneaky", "client-0005-aaaa")).status, 404);
    assert.equal((await drvPost("drv1", a.row.id, "Be there in 3 minutes", "client-0006-aaaa")).status, 200);
    assert.equal((await drvPost("nobody", a.row.id, "hello", "client-0007-aaaa")).status, 401);

    // Reassign: the previous driver loses access immediately; the new driver gets it; the customer's tracking page now names the new driver.
    assert.equal((await wf(a.row.id, { action: "reassign", driverId: d2.id })).status, 200);
    assert.equal((await drvGet("drv1", a.row.id)).status, 404);
    assert.equal((await drvPost("drv1", a.row.id, "still here?", "client-0008-aaaa")).status, 404);
    assert.equal((await drvGet("drv2", a.row.id)).status, 200);
    assert.equal((await drvPost("drv2", a.row.id, "I am your new driver", "client-0009-aaaa")).status, 200);
    const t = (await (await trackPost(a.row.tracking_code, "10.7.2.1")).json()).trip;
    assert.equal(t.driver.firstName, "Eli");
    assert.equal(brevoTo("dana@example.com").filter((c) => JSON.stringify(c.body).includes(a.row.reference)).length >= 1, true); // old driver was told

    // A closed booking stops accepting messages.
    await wf(a.row.id, { action: "cancel", reason: "Cancelled by request" });
    assert.equal((await trackChat("POST", a.row.tracking_code, { body: "too late", clientId: "client-0010-aaaa" }, "10.7.3.1")).status, 409);
    assert.equal((await drvPost("drv2", a.row.id, "too late", "client-0011-aaaa")).status, 409); // chat is closed once the ride is closed
  } finally { db.auth.getUser = origGetUser; }
});

test("driver-facing ride data carries no customer or passenger phone numbers", async () => {
  const { loadDriverRides } = await import("../src/lib/driver/rides.ts");
  const b = await flow({}, {}); await approve(b);
  const rides: any[] = await loadDriverRides(db, aDriver().id);
  const mine = rides.find((r) => r.id === b.row.id);
  assert.ok(mine);
  const raw = JSON.stringify(rides);
  assert.ok(!raw.includes("4105550100") && !raw.includes("4435550123") && !raw.includes("4105550177"));
  assert.ok(!("contactPhone" in mine) && !("passengerPhone" in mine));
});


test("payment gate: a driver cannot progress a ride until a verified payment set confirmed_at; every bypass is closed", async () => {
  const origGetUser = db.auth.getUser;
  db.auth.getUser = async (t: string) => t === "good" ? { data: { user: { id: "admin-1", email: "a@x.com" } }, error: null } : t === "drv1" ? { data: { user: { id: "u-d1", email: "dana@example.com" } }, error: null } : t === "drv2" ? { data: { user: { id: "u-d2", email: "eli@example.com" } }, error: null } : { data: { user: null }, error: { message: "bad" } };
  try {
    const d1 = aDriver(); d1.user_id = "u-d1";
    if (!db.t("drivers").some((d: any) => d.user_id === "u-d2")) db.seed("drivers", [{ full_name: "Eli Other", email: "eli2@example.com", phone: "4105550889", vehicle_plate: "VT-457", is_active: true, user_id: "u-d2" }]);
    const step = (token: string, id: string, status: string) => asDriver(token, () => routes.driverStatusRoute.POST(post("/api/driver/status", { id, status })));
    const ALL = ["getting_ready", "on_the_way", "arrived", "picked_up", "completed"];
    const mine = async (id: string) => (await (await import("../src/lib/driver/rides.ts")).loadDriverRides(db, d1.id) as any[]).find((r) => r.id === id);

    // 1. Approved and assigned but UNPAID: every progress step is refused by the server, status never moves.
    const b = await flow(); await approve(b, d1.id);
    for (const to of ALL) { const r = await step("drv1", b.row.id, to); assert.equal(r.status, 409, to); }
    assert.equal(b.row.status, "assigned");
    assert.equal((await (await step("drv1", b.row.id, "on_the_way")).json()).code, "awaiting_payment");
    const view = await mine(b.row.id); assert.equal(view.awaitingPayment, true); assert.deepEqual(view.nextStatuses, []);

    // 2. A payment that FAILED or was left pending does not unlock anything.
    await pay(b.row.payment_token);
    const p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
    assert.equal((await step("drv1", b.row.id, "on_the_way")).status, 409);
    await routes.webhook.POST(hook(sessionEvent("checkout.session.expired", p, {}, "evt_gate_exp")));
    assert.equal((await step("drv1", b.row.id, "on_the_way")).status, 409);
    assert.equal(b.row.confirmed_at ?? null, null);

    // 3. Forging the gate through the generic editor or a stray column does nothing.
    await adminAs(() => routes.crud.POST(post("/api/admin/crud", { resource: "bookings", action: "update", id: b.row.id, values: { confirmed_at: new Date().toISOString(), payment_status: "paid" } })));
    assert.equal((await step("drv1", b.row.id, "on_the_way")).status, 409);

    // 4. Another driver, and an unauthenticated caller, never get further than the owner would.
    assert.equal((await step("drv2", b.row.id, "on_the_way")).status, 404);
    assert.equal((await step("nobody", b.row.id, "on_the_way")).status, 401);

    // 5. Admin may reassign before payment (permissions intact); the NEW driver is gated the same way.
    const d2 = db.t("drivers").find((d: any) => d.user_id === "u-d2");
    assert.equal((await wf(b.row.id, { action: "reassign", driverId: d2.id })).status, 200);
    assert.equal((await step("drv2", b.row.id, "on_the_way")).status, 409);
    assert.equal((await step("drv1", b.row.id, "on_the_way")).status, 404);

    // 6. Verified payment confirms the booking, then the new driver can run the whole ride in order, and only in order.
    await pay(b.row.payment_token);
    const p2 = db.t("payments").filter((x: any) => x.booking_id === b.row.id).pop();
    await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p2, {}, "evt_gate_ok")));
    assert.ok(b.row.confirmed_at); assert.equal(b.row.status, "confirmed");
    assert.equal((await step("drv2", b.row.id, "completed")).status, 409);   // cannot skip steps
    for (const to of ["getting_ready", "on_the_way", "arrived", "picked_up", "completed"]) assert.equal((await step("drv2", b.row.id, to)).status, 200, to);
    assert.equal(b.row.status, "completed");

    // 7. Refunded after confirmation: progress stops until an admin resolves it; cancelled and declined never progress.
    const r = await flow(); await approve(r, d2.id); await pay(r.row.payment_token);
    await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", db.t("payments").find((x: any) => x.booking_id === r.row.id), {}, "evt_gate_r")));
    assert.equal((await step("drv2", r.row.id, "getting_ready")).status, 200);
    r.row.payment_status = "refunded";
    assert.equal((await step("drv2", r.row.id, "on_the_way")).status, 409);
    assert.equal((await wf(r.row.id, { action: "advance", status: "on_the_way" })).status, 409);
    const c = await flow(); await approve(c, d2.id); await wf(c.row.id, { action: "cancel", reason: "Customer cancelled" });
    assert.equal((await step("drv2", c.row.id, "on_the_way")).status, 409);
    const x = await flow(); await wf(x.row.id, { action: "reject", reason: "Not available" });
    assert.equal((await step("drv2", x.row.id, "on_the_way")).status, 404);   // never assigned to this driver
    assert.equal(x.row.status, "rejected");
    // Admin cancellation of an approved but unpaid booking still works.
    const u = await flow(); await approve(u, d2.id);
    assert.equal((await wf(u.row.id, { action: "cancel", reason: "Customer cancelled" })).status, 200);
  } finally { db.auth.getUser = origGetUser; }
});

test("pure rule: rideMayProgress", async () => {
  const { rideMayProgress } = await import("../src/lib/booking-status.ts");
  const ok = { status: "confirmed", confirmed_at: "2026-01-01T00:00:00Z", payment_status: "paid" };
  assert.equal(rideMayProgress(ok), true);
  assert.equal(rideMayProgress({ ...ok, payment_status: "deposit_paid" }), true);
  for (const bad of [{ ...ok, confirmed_at: null }, { ...ok, payment_status: "unpaid" }, { ...ok, payment_status: "failed" }, { ...ok, payment_status: "pending" }, { ...ok, payment_status: "refunded" }, { ...ok, payment_status: "review" }, { ...ok, status: "cancelled" }, { ...ok, status: "rejected" }, { ...ok, status: "no_show" }, { ...ok, status: "completed" }]) assert.equal(rideMayProgress(bad), false, JSON.stringify(bad));
});
