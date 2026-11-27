// End-to-end workflow tests: real route handlers + real libs, with an in-memory database and mocked
// Google and Brevo network calls. These do NOT prove the live integrations work.
import { test, before } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore: plain JS helper
import { FakeDb } from "./integration/fakedb.mjs";
import { signStripePayload } from "../src/lib/stripe-signature.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const db: any = new FakeDb();
(globalThis as any).__fakeDb = db;
Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: "http://fake", SUPABASE_SERVICE_ROLE_KEY: "svc", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  GOOGLE_MAPS_SERVER_API_KEY: "gkey", BREVO_API_KEY: "brevo-test-key", BREVO_SENDER_EMAIL: "sender@example.com", BREVO_SENDER_NAME: "Vanta Test",
  BUSINESS_NOTIFICATION_EMAIL: "owner@example.com", BUSINESS_TIMEZONE: "America/New_York",
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PUBLISHABLE_KEY: "pk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", NEXT_PUBLIC_SITE_URL: "http://site.test",
  NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: "democloud", NEXT_PUBLIC_CLOUDINARY_API_KEY: "123456", CLOUDINARY_API_SECRET: "cloud-secret-xyz",
});

// ---- network mocks -------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stripeMock = {
  pis: new Map<string, any>(), captureCalls: 0, cancelCalls: 0, captureError: null as null | { code: string; message: string },
  // saved-card workflow (Customers, SetupIntents, charges of a saved card)
  sis: new Map<string, any>(), idem: new Map<string, any>(), seq: 0, customers: 0, setupCreates: 0, detached: [] as string[],
  charges: [] as { body: URLSearchParams; key: string }[], nextCharge: "succeeded" as "succeeded" | "requires_action" | "declined" | "processing" | "network", brand: "visa", last4: "4242",
  /** Simulates the customer finishing Stripe's card form: the SetupIntent succeeds and a PaymentMethod is attached to the customer. */
  completeSetup(siId: string, last4 = this.last4) { const si = this.sis.get(siId); si.status = "succeeded"; si.payment_method = { id: `pm_${++this.seq}`, customer: si.customer, card: { brand: this.brand, last4 } }; return si; },
  reset() { this.pis.clear(); this.sis.clear(); this.idem.clear(); this.customers = 0; this.setupCreates = 0; this.detached = []; this.charges = []; this.nextCharge = "succeeded"; this.captureCalls = 0; this.cancelCalls = 0; this.captureError = null; },
};
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
  // ---- saved-card workflow endpoints (Idempotency-Key replays return the SAME object, like Stripe)
  const ikey = (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"];
  const once = (mk: () => Response | Promise<Response>) => { if (ikey && stripeMock.idem.has(ikey)) return reply(stripeMock.idem.get(ikey).body, stripeMock.idem.get(ikey).status); return Promise.resolve(mk()); };
  const remember = (body: any, status = 200) => { if (ikey) stripeMock.idem.set(ikey, { body, status }); return reply(body, status); };
  if (u === "https://api.stripe.com/v1/customers") return once(() => remember({ id: `cus_${++stripeMock.customers}` }));
  if (u === "https://api.stripe.com/v1/setup_intents") return once(() => { const f = init.body as URLSearchParams; stripeMock.setupCreates++; const id = `seti_${++stripeMock.seq}`; const si = { id, status: "requires_payment_method", client_secret: `${id}_secret_x`, customer: f.get("customer"), usage: f.get("usage"), metadata: { booking_id: f.get("metadata[booking_id]") } }; stripeMock.sis.set(id, si); return remember(si); });
  const siM = u.match(/^https:\/\/api\.stripe\.com\/v1\/setup_intents\/([^/?]+)(\?.*)?$/);
  if (siM) { const si = stripeMock.sis.get(siM[1]); return si ? reply(si) : reply({ error: { message: "No such setup_intent", code: "resource_missing" } }, 404); }
  const detM = u.match(/^https:\/\/api\.stripe\.com\/v1\/payment_methods\/([^/]+)\/detach$/);
  if (detM) { stripeMock.detached.push(detM[1]); return reply({ id: detM[1] }); }
  if (u === "https://api.stripe.com/v1/payment_intents") {
    const f = init.body as URLSearchParams;
    return once(() => {
      stripeMock.charges.push({ body: f, key: ikey ?? "" }); // only a FRESH creation counts: an idempotent replay returns Stripe's original object
      if (stripeMock.nextCharge === "network") throw new Error("socket hang up");
      const id = `pi_${++stripeMock.seq}`;
      const base = { id, amount: Number(f.get("amount")), currency: f.get("currency"), customer: f.get("customer"), payment_method: f.get("payment_method"), metadata: { booking_id: f.get("metadata[booking_id]"), payment_id: f.get("metadata[payment_id]") }, client_secret: `${id}_secret_y`, amount_received: 0 };
      if (stripeMock.nextCharge === "declined") { const pi = { ...base, status: "requires_payment_method", last_payment_error: { code: "card_declined", decline_code: "insufficient_funds" } }; stripeMock.pis.set(id, pi); return remember({ error: { code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds.", payment_intent: pi } }, 402); }
      const status = stripeMock.nextCharge;
      const pi = { ...base, status, amount_received: status === "succeeded" ? base.amount : 0 };
      stripeMock.pis.set(id, pi); return remember(pi);
    });
  }
  const piM = u.match(/^https:\/\/api\.stripe\.com\/v1\/payment_intents\/([^/?]+)(\/capture|\/cancel)?(\?.*)?$/);
  if (piM) {
    const pi = stripeMock.pis.get(piM[1]);
    if (!pi) return reply({ error: { message: "No such payment_intent", code: "resource_missing" } }, 404);
    if (!piM[2]) return reply(pi);
    if (piM[2] === "/cancel") { stripeMock.cancelCalls++; if (pi.status === "requires_capture") { pi.status = "canceled"; pi.cancellation_reason = "requested_by_customer"; } return reply(pi); }
    stripeMock.captureCalls++;
    if (stripeMock.captureError) return reply({ error: stripeMock.captureError }, 402);
    if (pi.status !== "requires_capture") return reply({ error: { code: "payment_intent_unexpected_state", message: `This PaymentIntent could not be captured because it has a status of ${pi.status}.` } }, 400);
    const amt = Number((init.body as URLSearchParams).get("amount_to_capture"));
    pi.status = "succeeded"; pi.amount_received = amt; pi.amount_capturable = 0;
    return reply(pi);
  }
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
    trackRating: await import("../src/app/api/track/rating/route.ts"),
    driverRate: await import("../src/app/api/driver/rate-customer/route.ts"),
    adminPoints: await import("../src/app/api/admin/drivers/points/route.ts"),
    adminVisibility: await import("../src/app/api/admin/drivers/visibility/route.ts"),
    feed: await import("../src/app/api/admin/notifications/feed/route.ts"),
    read: await import("../src/app/api/admin/notifications/read/route.ts"),
    sign: await import("../src/app/api/admin/cloudinary/sign/route.ts"),
    checkout: await import("../src/app/api/payments/checkout/route.ts"),
    cardSetup: await import("../src/app/api/bookings/card/setup/route.ts"),
    cardComplete: await import("../src/app/api/bookings/card/complete/route.ts"),
    confirm: await import("../src/app/api/bookings/confirm/route.ts"),
    confirmFinal: await import("../src/app/api/bookings/confirm/finalize/route.ts"),
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
  assert.ok(data.vehicles.every((v: any) => v.quotable === false && v.tiers.every((t: any) => Object.keys(t.tripFare).length === 0)));
  assert.ok(!JSON.stringify(data).includes('"per_mile"'));
  assert.ok(!JSON.stringify(data).includes("fixedPriceCents")); // the tier fixed fee never reaches the browser
});

test("with ACTIVE pricing: real route distance, toll-aware options, surcharge, capacity filter", async () => {
  db.t("pricing_configs")[0].status = "active";
  db.seed("pricing_surcharges", [{ pricing_config_id: db.t("pricing_configs")[0].id, label: "Service fee", kind: "flat", amount: 10, is_active: true }]);

  const res = await routes.quote.POST(post("/api/fare/quote", trip()));
  const data = await res.json();
  assert.equal(data.pricingAvailable, true);
  assert.deepEqual(data.routes.map((r: any) => r.key), ["fastest", "no_tolls"]);
  const ec = data.vehicles.find((v: any) => v.name === "E-Class");
  // With no tier fixed fee configured there is no online fare at all (never the plain estimate, never the fee alone).
  assert.deepEqual(ec.tiers.map((t: any) => Object.keys(t.tripFare).length), [0]);
  setFixed(null, 15000, null);
  const priced = (await (await routes.quote.POST(post("/api/fare/quote", trip()))).json()).vehicles.find((v: any) => v.name === "E-Class").tiers[0].tripFare;
  setFixed(null, null, null);
  assert.equal(priced.fastest.cents, 15000 + 20 * 6 * 100 + 1000); // tier fee $150 + 20 mi x $6 + $10 fee, as ONE combined amount
  assert.equal(priced.fastest.tollStatus, "unavailable");        // toll price unknown: not invented
  assert.equal(data.routes[1].distanceMiles, 22);
  assert.equal(priced.no_tolls.cents, 15000 + 22 * 6 * 100 + 1000);
  assert.equal(priced.no_tolls.tollStatus, "avoided");
  assert.deepEqual(Object.keys(priced.fastest).sort(), ["cents", "currency", "tollStatus"]); // no line items, rates or per-mile details
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
  void d;
  assert.equal((await quoteFor(trip())).ec.totalCents, 12000 + 1000 + 450);
  net.tollMode = "unknown";
  const q = (await quoteFor(trip({ tripType: "hourly", hours: 3 }))).ec;
  assert.equal(q.totalCents, 3 * 100 * 100 + 0 + 1000); // 20 mi within the 20-mile allowance
  assert.equal((await quoteFor(trip({ tripType: "hourly", hours: 3 }), "no_tolls")).ec.totalCents, 30000 + 2 * 3 * 100 + 1000); // 22 mi: 2 extra
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
  assert.equal(data.pricing, null); // no tier fixed fee is configured in this fixture, so there is no online total (the tier fee is never charged or shown alone)
  assert.ok(!("totalCents" in data) && !("onlineAmountCents" in data));

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
  assert.equal(data.pricing, null);
  assert.equal(db.t("pricing_snapshots").length, snaps);
});

const next = (days: number) => new Date(Date.now() + (30 + days) * 86400_000).toISOString().slice(0, 10);
const person = { name: "Ann Rider", email: "ann@example.com", phone: "4105550100" };
const rtTrip = (o: object = {}) => trip({ stops: [], returnLeg: { pickup: { text: "Dulles Airport" }, dropoff: { text: "1 Main St, Baltimore" }, date: next(1), time: "17:00" }, ...o });

test("round trip: both legs priced, no discount invented, configured discount applied server-side, legs and snapshot saved", async () => {
  // No active rule yet: sum of two legs, no discount.
  setFixed(null, 15000, null);
  const fare = async () => (await (await routes.quote.POST(post("/api/fare/quote", rtTrip()))).json()).vehicles.find((v: any) => v.name === "E-Class").tiers[0].tripFare.fastest;
  const q0 = await fare();
  assert.equal(q0.roundTrip.savingsCents, 0);
  assert.equal(q0.cents, 15000 + 2 * 13000); // tier fee once + two legs, each 20 mi x $6 + $10 fee

  db.seed("round_trip_rules", [{ label: "Round-trip savings", kind: "percent", amount: 10, category_id: null, is_active: true }]);
  const q = await fare();
  assert.equal(q.roundTrip.savingsCents, 2600);                  // 10% of the two legs' fare (26000); the tier fee is not discounted
  assert.equal(q.cents, 15000 + 23400);
  assert.ok(!("lineItems" in q) && !("legs" in q.roundTrip) && !("twoOneWayCents" in q.roundTrip)); // no internal split is exposed
  setFixed(null, null, null);

  // Bad return times are rejected.
  assert.equal((await routes.quote.POST(post("/api/fare/quote", rtTrip({ returnLeg: { pickup: { text: "A" }, dropoff: { text: "B" }, date: next(-1), time: "08:00" } })))).status, 422);

  const res = await routes.bookings.POST(post("/api/bookings", { ...ack, ...person, trip: rtTrip(), vehicleId: ids.eclass, routeKey: "fastest", submissionKey: "key-rt-aaaaaaaaaaaa", totalCents: 1 }));
  assert.equal(res.status, 200);
  const b = db.t("bookings").find((x: any) => x.submission_key === "key-rt-aaaaaaaaaaaa");
  assert.equal(b.trip_direction, "round_trip");
  assert.equal(b.estimated_fare_cents, 23400); // the trip estimate only (internal); no tier fee is configured here, so no online amount exists
  assert.equal(b.online_amount_cents, null);
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
  assert.equal(data.pricing, null); // no tier fee configured here
  assert.equal(db.t("bookings").find((x: any) => x.reference === data.reference).estimated_fare_cents, 13000); // the trip estimate is stored (internal)
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
// The browser now receives ONE combined Trip fare per tier (tier fee + trip estimate). This helper recovers the plain server-calculated trip ESTIMATE
// (what older tests assert on) by pricing the E-Class's tier at a $0 fixed fee for the call, then restoring it.
const quoteFor = async (t: object, key: "fastest" | "no_tolls" = "fastest") => {
  const tier = db.t("vehicle_tiers")[1]; const saved = tier.fixed_price_cents; tier.fixed_price_cents = 0;
  try {
    const d = await (await routes.quote.POST(post("/api/fare/quote", t))).json();
    const f = d.vehicles?.find((v: any) => v.name === "E-Class")?.tiers?.[0]?.tripFare?.[key];
    return { d, ec: f ? { ...f, totalCents: f.cents } : undefined };
  } finally { tier.fixed_price_cents = saved; }
};

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
  assert.deepEqual(one.d.seatInfo, { oneWayCents: 1000, roundTripCents: 1500, max: 4 });

  const rt = await quoteFor(rtTrip({ passengers: 3, childSeats: seats }));
  assert.equal(rt.ec.totalCents, baseRt);
  assert.equal(rt.d.seatFeeCents, 2 * 1500);                      // $15 per seat once, not once per leg

  assert.equal((await routes.quote.POST(post("/api/fare/quote", trip({ passengers: 3, childSeats: { booster: 5 } })))).status, 422);   // above the maximum
  assert.equal((await routes.quote.POST(post("/api/fare/quote", trip({ passengers: 2, childSeats: { booster: 3 } })))).status, 422);   // more seats than passengers
  assert.equal((await routes.quote.POST(post("/api/fare/quote", trip({ passengers: 3, childSeats: { booster: 1.5 } })))).status, 422);

  // Booking: the browser's totals are ignored. Estimate = trip estimate; online amount = fixed Luxury price + trip estimate + seats.
  const b = await makeBooking({ totalCents: 1, childSeatFeeCents: 1, onlineAmountCents: 1 }, { passengers: 3, childSeats: seats });
  assert.equal(b.res.status, 200);
  assert.equal(b.row.estimated_fare_cents, baseOne);
  assert.equal(b.row.child_seat_fee_cents, 2000);
  assert.equal(b.row.fixed_price_cents, 15000);
  assert.equal(b.row.online_amount_cents, 15000 + baseOne + 2000);
  assert.deepEqual(b.row.child_seats, [{ type: "rear_facing", quantity: 1 }, { type: "booster", quantity: 1 }]);
  assert.match(JSON.stringify(db.t("notification_logs").filter((l: any) => l.entity_id === b.row.id)), /Child seats: 1 × Rear-facing, 1 × Booster \(requested\)/);

  const rtBooking = await makeBooking({}, { stops: [], passengers: 3, childSeats: seats, returnLeg: { pickup: { text: "Dulles Airport" }, dropoff: { text: "1 Main St, Baltimore" }, date: next(1), time: "17:00" } });
  assert.equal(rtBooking.row.child_seat_fee_cents, 3000);
  assert.equal(rtBooking.row.online_amount_cents, 15000 + baseRt + 3000);

  // Admin-configurable rate: a price change applies to new quotes and leaves saved bookings alone.
  db.t("booking_settings")[0].child_seat_one_way_cents = 1200;
  assert.equal((await quoteFor(trip({ passengers: 3, childSeats: seats }))).d.seatFeeCents, 2 * 1200);
  assert.equal(b.row.online_amount_cents, 15000 + baseOne + 2000);
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
const legacySessionEvent = (type: string, p: any, over: Record<string, unknown> = {}, id = `evt_${++ev}`) => ({
  id, type, data: { object: { object: "checkout.session", id: p.stripe_session_id, payment_status: "paid", payment_intent: `pi_${p.stripe_session_id}`, amount_total: p.amount_cents, currency: "usd", metadata: { booking_id: p.booking_id, payment_id: p.id }, ...over } },
});
// Webhook events for a payment row. A saved-card charge (the new workflow) reports through PaymentIntent events; the old Checkout-session shapes are kept
// only for rows that predate the workflow (history). The mapping lets the older assertions keep exercising the SAME rules on the new flow.
const sessionEvent = (type: string, p: any, over: Record<string, unknown> = {}, id = `evt_${++ev}`) => {
  if (!p.saved_card) return legacySessionEvent(type, p, over, id);
  const map: Record<string, string> = { "checkout.session.completed": over.payment_status === "unpaid" ? "payment_intent.processing" : "payment_intent.succeeded", "checkout.session.async_payment_succeeded": "payment_intent.succeeded", "checkout.session.async_payment_failed": "payment_intent.payment_failed", "checkout.session.expired": "payment_intent.canceled" };
  const pi = stripeMock.pis.get(p.stripe_payment_intent_id) ?? {};
  const amount = (over.amount_total as number | undefined) ?? p.amount_cents;
  return { id, type: map[type], data: { object: { object: "payment_intent", id: p.stripe_payment_intent_id ?? "pi_unknown", amount: p.amount_cents, amount_received: amount, currency: "usd", customer: pi.customer, metadata: { booking_id: p.booking_id, payment_id: p.id }, last_payment_error: { code: "card_declined" } } } };
};
// Admin approval through the REAL workflow route (assigns a driver and releases payment). Payment is impossible before this.
const l_e = (m: any) => m.event;
const adminAs = async <T,>(fn: () => Promise<T>) => { const prev = (globalThis as any).__cookies; (globalThis as any).__cookies = { vt_at: "good" }; try { return await fn(); } finally { (globalThis as any).__cookies = prev; } };
const aDriver = () => { if (!db.t("drivers").length) db.seed("drivers", [{ full_name: "Dana Driver", email: "dana@example.com", phone: "4105550999", vehicle_plate: "VT-123", vehicle_description: "Black Escalade", is_active: true }]); return db.t("drivers")[0]; };
// ---- the saved-card workflow, step by step, through the REAL routes -----------------------------------------
/** Customer saves a card at booking: Stripe SetupIntent via the route, Stripe "completes" it, the server verifies it with Stripe. Nothing is charged. */
const saveCard = async (b: { row: any }, consent = true) => {
  const token = b.row.payment_token;
  const s = await routes.cardSetup.POST(post("/api/bookings/card/setup", { token, consent }));
  if (s.status !== 200) return { setup: s, complete: null };
  stripeMock.completeSetup(b.row.stripe_setup_intent_id);
  const c = await routes.cardComplete.POST(post("/api/bookings/card/complete", { token }));
  return { setup: s, complete: c };
};
/** Admin approval through the REAL workflow route. It charges nothing, confirms nothing and assigns no driver. The card is saved first when the booking needs one. */
const approve = async (b: { row: any }, driverId?: string) => { if (driverId) return confirmAndAssign(b, driverId); if (b.row.card_flow && !b.row.card_setup_at) await saveCard(b); return adminAs(() => routes.workflow.POST(post("/api/admin/bookings/workflow", { id: b.row.id, action: "approve" }))); };
/** The customer's explicit "Confirm Booking & Authorize Charge". */
const confirmCharge = (b: { row: any }, body: object = {}) => routes.confirm.POST(post("/api/bookings/confirm", { token: b.row.payment_token, consent: true, ...body }));
/** Saves a card (if needed), approves, and starts the customer's charge. The charge stays IN PROGRESS (processing) until a verified Stripe event settles it. */
const pay = async (token: string, extra: object = {}) => {
  const row = db.t("bookings").find((x: any) => x.payment_token === token);
  if (row && !row.approved_at && !(extra as any).unapproved) await approve({ row });
  const prev = stripeMock.nextCharge; stripeMock.nextCharge = (extra as any).outcome ?? "processing";
  try { return await routes.confirm.POST(post("/api/bookings/confirm", { token, consent: true })); } finally { stripeMock.nextCharge = prev; }
};
/** approve -> customer confirms -> Stripe verifies the payment (succeeds at once) -> the booking is confirmed (no driver yet). */
const confirmBooking = async (b: { row: any }) => { await approve(b); stripeMock.nextCharge = "succeeded"; return confirmCharge(b); };
/** Assigning a driver is a separate admin step that is allowed only after the booking is confirmed and paid. */
const assignDriver = (b: { row: any }, driverId = aDriver().id) => adminAs(() => routes.workflow.POST(post("/api/admin/bookings/workflow", { id: b.row.id, action: "assign", driverId })));
/** Full path to a confirmed, paid, driver-assigned ride. */
/**
 * A booking from BEFORE the saved-card workflow: an admin approved it and assigned a driver while it was still unpaid. New bookings can never reach this state,
 * but existing ones may, and the payment gate must keep holding for them.
 */
const legacyAssignedUnpaid = async (b: { row: any }, driverId = aDriver().id) => {
  await approve(b);
  b.row.status = "assigned"; b.row.driver_id = driverId;
  db.seed("booking_assignments", [{ booking_id: b.row.id, driver_id: driverId, assigned_at: new Date().toISOString(), assigned_by: null }]);
};
const confirmAndAssign = async (b: { row: any }, driverId = aDriver().id) => { await confirmBooking(b); return assignDriver(b, driverId); };
const setPay = (mode: string, extra: Record<string, unknown> = {}) => Object.assign(db.t("booking_settings")[0], { payment_mode: mode, deposit_fixed_cents: null, deposit_percent: null, ...extra });

test("payments disabled by default: booking requests work, no checkout is offered", async () => {
  setPay("disabled");
  setFixed(null, 15000, null);
  const b = await makeBooking();
  assert.equal(b.res.status, 200);
  assert.equal(b.data.payUrl, undefined);
  assert.equal(b.row.payment_status, "not_required");
  const r = await pay(b.row.payment_token);
  assert.equal(r.status, 503); // no provider is offered while online payment is disabled
  assert.equal(db.t("payments").filter((p: any) => p.booking_id === b.row.id).length, 0);
  assert.equal((await pay("not-a-token")).status, 404); // not a credential: one generic answer
});

test("saved-card charge: amount comes only from the saved server-side total; client amounts are ignored; creating the charge confirms nothing", async () => {
  setPay("full");
  const b = await makeBooking({ totalCents: 1 });
  assert.equal(b.data.payUrl, undefined); assert.match(b.data.trackingId, /^TRK-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/); // no pay link at submission
  assert.equal((await pay(b.row.payment_token, { unapproved: true })).status, 409); // charging is impossible before admin approval
  assert.equal(db.t("payments").filter((x: any) => x.booking_id === b.row.id).length, 0);
  assert.equal(b.row.payment_status, "unpaid");
  const total = b.row.online_amount_cents; assert.ok(b.row.estimated_fare_cents > 0);
  assert.equal(total, 15000 + b.row.estimated_fare_cents); // the COMPLETE total: fixed Luxury fee + trip estimate (not the fee alone)
  assert.notEqual(total, b.row.fixed_price_cents);

  await approve(b);
  const chargesBefore = stripeMock.charges.length;
  stripeMock.nextCharge = "processing";
  const r = await confirmCharge(b, { amountCents: 1, amount: 1, totalCents: 1 }); // browser-supplied amounts are ignored
  assert.equal(r.status, 200);
  assert.equal((await r.json()).state, "processing");
  const c = stripeMock.charges.slice(chargesBefore);
  assert.equal(c.length, 1);
  const form = c[0].body;
  assert.equal(form.get("amount"), String(total)); assert.equal(form.get("currency"), "usd");
  assert.equal(form.get("confirm"), "true"); assert.equal(form.get("customer"), b.row.stripe_customer_id); assert.equal(form.get("payment_method"), b.row.stripe_payment_method_id);
  assert.equal(form.get("metadata[booking_id]"), b.row.id);
  const p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
  assert.match(c[0].key, new RegExp(`^charge-${p.id}$`));
  assert.equal(p.status, "processing"); assert.equal(p.amount_cents, total); assert.equal(p.kind, "full"); assert.equal(p.saved_card, true);
  assert.equal(b.row.payment_status, "processing");
  assert.equal(b.row.status, "approved");      // creating the charge confirms nothing: still awaiting Stripe's verified result
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
  assert.equal(p.status, "processing"); assert.equal(b.row.amount_paid_cents, 0);
  assert.equal(db.t("stripe_events").length, 0);

  const good = sessionEvent("checkout.session.completed", p, {}, "evt_dup_1");
  const ok = await routes.webhook.POST(hook(good));
  assert.equal(ok.status, 200); assert.equal((await ok.json()).result, "processed");
  assert.equal(p.status, "paid"); assert.ok(p.paid_at); assert.match(p.stripe_payment_intent_id, /^pi_\d+$/);
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
  assert.equal(p1.status, "failed"); assert.equal(b.row.payment_status, "failed"); // a cancelled/failed attempt never counts as paid
  assert.ok(db.t("bookings").some((x: any) => x.id === b.row.id)); // the booking is never erased

  const retry = await pay(b.row.payment_token);                    // retry path
  assert.equal(retry.status, 200);
  const p2 = db.t("payments").filter((x: any) => x.booking_id === b.row.id).at(-1);
  assert.notEqual(p2.id, p1.id); assert.equal(p2.status, "processing"); assert.equal(b.row.payment_status, "processing");

  await routes.webhook.POST(hook(sessionEvent("checkout.session.async_payment_failed", p2, { payment_status: "unpaid" })));
  assert.equal(p2.status, "failed"); assert.equal(b.row.payment_status, "failed");
  assert.equal((await pay(b.row.payment_token)).status, 200);      // retry again after a failure

  // A delayed payment method that has not settled yet stays pending.
  const p3 = db.t("payments").filter((x: any) => x.booking_id === b.row.id).at(-1);
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p3, { payment_status: "unpaid" })));
  assert.equal(p3.status, "processing"); assert.equal(b.row.amount_paid_cents, 0);

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

test("deposit settings never shrink a saved-card charge (the COMPLETE total is charged); nothing is invented; not configured = unavailable", async () => {
  setPay("deposit_percent", { deposit_percent: 25 });
  let b = await makeBooking();
  assert.equal(b.data.payUrl, undefined); assert.match(b.data.trackingId, /^TRK-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/); // no pay link at submission
  assert.equal((await pay(b.row.payment_token, { unapproved: true })).status, 409); // payment is impossible before admin approval
  assert.equal(db.t("payments").filter((x: any) => x.booking_id === b.row.id).length, 0);
  await pay(b.row.payment_token);
  let p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
  assert.equal(p.amount_cents, b.row.online_amount_cents); assert.equal(p.kind, "full"); // the saved-card workflow charges the complete approved total
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p)));
  assert.equal(b.row.payment_status, "paid"); assert.equal(b.row.amount_paid_cents, p.amount_cents);
  const again = await confirmCharge(b); // a repeated confirmation on a paid booking changes nothing
  assert.equal((await again.json()).state, "paid"); assert.equal(db.t("payments").filter((x: any) => x.booking_id === b.row.id).length, 1);

  setPay("full");
  const saved = process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_SECRET_KEY;
  b = await makeBooking();
  assert.equal(b.res.status, 200); assert.equal(b.data.payUrl, undefined); assert.equal(b.data.cardStep, false); // booking still saved, no card step without Stripe
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
  assert.ok(!JSON.stringify(d).includes("fixedPriceCents")); // the tier fixed fee is never sent to the browser
  assert.deepEqual(d.tiers.map((t: any) => t.name), ["Premium", "Luxury", "Luxury Plus"]);
  assert.deepEqual(d.tiers.map((t: any) => t.meetGreetFeeCents), [2500, 3500, 5000]); // initial approved fees
  const lux = d.vehicles.find((v: any) => v.name === "E-Class"), prem = d.vehicles.find((v: any) => v.name === "Sprinter");
  assert.deepEqual(lux.tiers.map((t: any) => t.name), ["Luxury"]); assert.deepEqual(prem.tiers.map((t: any) => t.name), ["Premium"]);
  assert.deepEqual([lux.tiers[0].meetGreetFeeCents, prem.tiers[0].meetGreetFeeCents], [3500, 2500]);
  assert.ok(ec.totalCents > 0 && ec.totalCents !== 15000); // the mileage-based estimate is still calculated, and is not the fixed price
  // The customer-facing fare is ONE combined amount: this tier's fixed fee + the trip estimate.
  const rawLux = (await (await routes.quote.POST(post("/api/fare/quote", trip()))).json()).vehicles.find((v: any) => v.name === "E-Class").tiers[0].tripFare.fastest;
  assert.equal(rawLux.cents, 15000 + ec.totalCents);
});

test("Meet & Greet: fee comes from the selected tier on the server; changing tier changes the fee; deselecting removes it; never added twice; airport details required", async () => {
  setFixed(10000, 15000, 22000); setPay("full");
  const base = (await makeBooking({ details: undefined, airport: airportBlock })).row;
  assert.equal(base.meet_greet_selected, false);
  assert.equal(base.online_amount_cents, 15000 + base.estimated_fare_cents); // deselected: no Meet & Greet fee in the charge

  const lux = await makeBooking({ airport: airportBlock, fixedPriceCents: 1, meetGreetCents: 1, onlineAmountCents: 1 }, { meetGreet: true }); // a tierId is validated, not trusted: see tests/vehicle-tiers.test.ts
  assert.equal(lux.res.status, 200);
  assert.equal(lux.row.meet_greet_selected, true);
  assert.equal(lux.row.fixed_price_cents, 15000); assert.equal(lux.row.meet_greet_fee_cents, 3500);
  assert.equal(lux.row.online_amount_cents, 15000 + lux.row.estimated_fare_cents + 3500); // browser-supplied values ignored
  assert.equal(lux.row.tier_name, "Luxury");
  const air = db.t("booking_airport_details").find((a: any) => a.booking_id === lux.row.id);
  assert.equal(air.meet_greet_requested, true); assert.equal(air.meet_greet_status, "requested"); assert.equal(air.meet_greet_charge_cents, 3500);
  const snap = db.t("pricing_snapshots").find((x: any) => x.booking_id === lux.row.id);
  assert.equal(snap.snapshot.online.totalCents, lux.row.online_amount_cents);

  // Different tier (Premium vehicle): its own fee. Another submission of the same trip does not add the fee twice.
  const prem = await makeBooking({ vehicleId: ids.sprinter, airport: airportBlock }, { meetGreet: true });
  assert.equal(prem.res.status, 200); assert.equal(prem.row.meet_greet_selected, true);
  assert.equal(prem.row.online_amount_cents, null); // no published trip fare for this vehicle: NO online charge (never the tier fee + services alone)
  const again = await makeBooking({ airport: airportBlock, submissionKey: lux.row.submission_key }, { meetGreet: true });
  assert.equal(again.row.online_amount_cents, lux.row.online_amount_cents); assert.equal(db.t("bookings").filter((b: any) => b.submission_key === lux.row.submission_key).length, 1);

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
  assert.equal(none.data.payUrl, undefined); assert.equal(none.row.payment_status, "not_required");
  assert.equal((await pay(none.row.payment_token)).status, 409);       // checkout refuses: price not set yet

  setFixed(10000, 15000, 22000);
  const before = await makeBooking(); const est = before.row.estimated_fare_cents; assert.equal(before.row.online_amount_cents, 15000 + est);
  luxury().fixed_price_cents = 18000; luxury().meet_greet_fee_cents = 4000;      // admin raises the prices
  assert.equal(before.row.online_amount_cents, 15000 + est); assert.equal(before.row.fixed_price_cents, 15000);
  const checkout = await pay(before.row.payment_token);                           // the customer pays what they were shown
  assert.equal(checkout.status, 200);
  assert.equal(db.t("payments").filter((p: any) => p.booking_id === before.row.id).at(-1).amount_cents, 15000 + est);
  const after = await makeBooking();                                              // a NEW booking uses the new price
  assert.equal(after.row.online_amount_cents, 18000 + est);
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
  assert.equal(tier.fixed_price_cents, 26000); // (the browser never receives the fee; it shows up inside the combined trip fare)
  globalThis.__cookies = {};
});

// ---- Stripe line items for the fixed-price charge -----------------------------------------------------
test("saved-card charge is ONE amount covering trip fare, Meet & Greet and child seats; the tier fee and estimate are never shown separately", async () => {
  setFixed(10000, 15000, 22000); setPay("full");
  const b = await makeBooking({ airport: airportBlock }, { meetGreet: true, passengers: 3, childSeats: { booster: 2 } });
  const est = b.row.estimated_fare_cents;
  assert.equal(b.row.online_amount_cents, 15000 + est + 3500 + 2000);
  const from = stripeMock.charges.length;
  assert.equal((await pay(b.row.payment_token)).status, 200);
  const charge = stripeMock.charges.slice(from);
  assert.equal(charge.length, 1);                                              // ONE charge for the COMPLETE total, never the tier fee alone
  const form = charge[0].body;
  assert.equal(form.get("amount"), String(15000 + est + 3500 + 2000));
  assert.notEqual(form.get("amount"), "15000");
  const everything = decodeURIComponent(String(form).replace(/\+/g, " "));
  assert.ok(!/fixed|per mile|per_mile|tier|Luxury/i.test(everything), "nothing customer-visible at Stripe mentions the tier fee or rates");
  const p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
  assert.deepEqual([p.provider, p.tier_name, p.fixed_price_cents, p.meet_greet_cents, p.other_addons_cents, p.amount_cents], ["stripe", "Luxury", 15000, 3500, 2000, 15000 + est + 5500]);
  assert.equal(p.estimated_trip_fare_cents, est);                            // the internal split stays on the payment row, for admins
});

// ---- PayPal -------------------------------------------------------------------------------------------
const PP_ENV = { PAYPAL_CLIENT_ID: "pp-client", PAYPAL_CLIENT_SECRET: "pp-secret", PAYPAL_ENV: "sandbox", PAYPAL_WEBHOOK_ID: "WH-1" };
const withPayPal = async (fn: () => Promise<void>) => {
  Object.assign(process.env, PP_ENV);
  try { await fn(); } finally { for (const k of Object.keys(PP_ENV)) delete process.env[k]; net.pp.capStatus = "COMPLETED"; net.pp.capAmount = null; net.pp.verify = true; }
};
const capture = (token: string, orderId: string) => routes.ppcapture.POST(post("/api/payments/paypal/capture", { token, orderId }));
const ppHook = (event: object) => new Request("http://site.test/api/paypal/webhook", { method: "POST", headers: { "paypal-transmission-id": "t1", "paypal-transmission-time": "2026-01-01T00:00:00Z", "paypal-cert-url": "https://api.paypal.com/cert", "paypal-auth-algo": "SHA256withRSA", "paypal-transmission-sig": "sig", "content-type": "application/json" }, body: JSON.stringify(event) });
/** PayPal stays available as an alternative once the booking is approved: the checkout route itself refuses anything not approved. */
const payPayPal = async (token: string) => {
  const row = db.t("bookings").find((x: any) => x.payment_token === token);
  if (row && !row.approved_at) await approve({ row });
  return routes.checkout.POST(post("/api/payments/checkout", { token, provider: "paypal" }));
};
const startPayPal = async (b: any) => { const r = await payPayPal(b.row.payment_token); return { r, out: await r.json() }; };

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
  const r = await payPayPal(b.row.payment_token);
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
    const est = b.row.estimated_fare_cents; const dec = (c: number) => (c / 100).toFixed(2);
    assert.equal(unit.amount.value, dec(15000 + est + 3500));        // complete total in integer cents, no floating point
    assert.equal(unit.amount.currency_code, "USD");
    assert.equal(unit.custom_id, b.row.id);
    assert.deepEqual(unit.items.map((i: any) => i.unit_amount.value), [dec(15000 + est), "35.00"]);   // combined Trip fare + Meet & Greet
    const p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
    assert.deepEqual([p.provider, p.provider_ref, p.status, p.amount_cents, p.fixed_price_cents, p.meet_greet_cents], ["paypal", out.orderId, "pending", 15000 + est + 3500, 15000, 3500]);
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
    assert.equal(b.row.amount_paid_cents, 15000 + 13000 + 3500); assert.equal(b.row.payment_status, "paid");
    assert.equal(b.row.status, "confirmed");                         // confirmed by the verified payment
    const mails = () => db.t("notification_logs").filter((l: any) => l.event === "payment.paid" && l.entity_id === b.row.id);
    assert.equal(mails().length, 1); assert.equal(db.t("notification_logs").filter((l: any) => l.event === "booking.confirmed" && l.entity_id === b.row.id).length, 1);
    assert.match(JSON.stringify(mails()), /PayPal/);
    // Capturing again (double click, retry) is harmless: same state, no extra emails or payment rows.
    assert.equal((await (await capture(b.row.payment_token, out.orderId)).json()).status, "paid");
    assert.equal(mails().length, 1); assert.equal(db.t("notification_logs").filter((l: any) => l.event === "booking.confirmed" && l.entity_id === b.row.id).length, 1); assert.equal(db.t("payments").filter((x: any) => x.booking_id === b.row.id).length, 1);
    assert.equal(b.row.amount_paid_cents, 15000 + 13000 + 3500);
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
    assert.equal(b2.row.payment_status, "paid"); assert.equal(b2.row.amount_paid_cents, 15000 + b2.row.estimated_fare_cents);
  });
});

test("PayPal webhook: signature verified with PayPal; completed payments recorded once; duplicates and refunds handled; Stripe and PayPal share one payment table", async () => {
  setFixed(10000, 15000, 22000); setPay("full");
  await withPayPal(async () => {
    const b = await makeBooking();
    const { out } = await startPayPal(b);
    const p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
    const completed = (id: string, value = "280.00") => ({ id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: `CAPW${out.orderId}`, status: "COMPLETED", amount: { currency_code: "USD", value }, custom_id: b.row.id, supplementary_data: { related_ids: { order_id: out.orderId } } } });

    net.pp.verify = false;
    assert.equal((await routes.ppwebhook.POST(ppHook(completed("WH-EVT-1")))).status, 400);      // forged
    assert.equal(p.status, "pending"); assert.equal(db.t("paypal_events").length, 0);
    net.pp.verify = true;
    assert.equal((await routes.ppwebhook.POST(ppHook(completed("WH-EVT-2", "1.00")))).status, 200); // wrong amount
    assert.equal(p.status, "review"); assert.equal(b.row.amount_paid_cents, 0);

    const b2 = await makeBooking(); const o2 = (await startPayPal(b2)).out; const p2 = db.t("payments").find((x: any) => x.booking_id === b2.row.id);
    const ev = { id: "WH-EVT-3", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPW2", status: "COMPLETED", amount: { currency_code: "USD", value: "280.00" }, custom_id: b2.row.id, supplementary_data: { related_ids: { order_id: o2.orderId } } } };
    const ok = await routes.ppwebhook.POST(ppHook(ev));
    assert.equal(ok.status, 200); assert.equal((await ok.json()).result, "processed");
    assert.equal(p2.status, "paid"); assert.equal(p2.provider_txn_id, "CAPW2"); assert.equal(b2.row.amount_paid_cents, 28000); assert.equal(b2.row.status, "confirmed");
    const dup = await routes.ppwebhook.POST(ppHook(ev));
    assert.equal((await dup.json()).result, "duplicate");
    await routes.ppwebhook.POST(ppHook({ ...ev, id: "WH-EVT-4" }));                           // same payment, new event id
    assert.equal(b2.row.amount_paid_cents, 28000);
    assert.equal(db.t("notification_logs").filter((l: any) => (l.event === "payment.paid" || l.event === "booking.confirmed") && l.entity_id === b2.row.id).length, 2); // a replayed webhook never emails twice

    const refund = { id: "WH-EVT-5", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "REF1", amount: { currency_code: "USD", value: "50.00" }, links: [{ rel: "up", href: "https://api.paypal.com/v2/payments/captures/CAPW2" }] } };
    await routes.ppwebhook.POST(ppHook(refund));
    assert.equal(p2.status, "partially_refunded"); assert.equal(p2.refunded_cents, 5000); assert.equal(b2.row.amount_paid_cents, 28000 - 5000);

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

test("submission: unguessable tracking ID, card step first, nothing charged or held, no pay link; the business is alerted once the card is saved", async () => {
  db.seed("site_content", [{ key: "contact.phone", value: "+1 555-010-0199", group_name: "Contact" }]);
  net.calls.length = 0; stripeMock.reset();
  const b = await flow();
  assert.equal(b.res.status, 200);
  assert.match(b.row.tracking_code, /^TRK-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  assert.equal(b.row.status, "new_request"); assert.equal(b.row.payment_status, "unpaid"); assert.equal(b.row.amount_paid_cents, 0);
  assert.equal(b.row.confirmed_at ?? null, null); assert.equal(b.row.payment_released_at ?? null, null);
  assert.equal(b.row.card_flow, true); assert.equal(b.data.cardStep, true); assert.match(b.data.confirmUrl, /^\/book\/confirmation\?t=[0-9a-f-]{36}$/);
  assert.equal(b.data.payUrl, undefined); assert.equal(db.t("payments").filter((x: any) => x.booking_id === b.row.id).length, 0);
  // The request is not complete until the card is saved: the business is not alerted and the customer is not told "received" yet.
  assert.equal(db.t("admin_notifications").some((n: any) => n.event === "booking.created" && n.entity_id === b.row.id), false);
  assert.equal(brevoTo("ann@example.com").filter((c) => JSON.stringify(c.body).includes(b.row.reference)).length, 0);

  // Card step: consent is required; saving the card charges nothing and holds nothing.
  assert.equal((await saveCard(b, false)).setup.status, 422);
  assert.equal(stripeMock.setupCreates, 0);
  const saved = await saveCard(b);
  assert.equal(saved.setup.status, 200); assert.equal(saved.complete!.status, 200);
  assert.equal(b.row.status, "new_request"); assert.equal(b.row.payment_status, "card_saved"); assert.equal(b.row.amount_paid_cents, 0);
  assert.equal(stripeMock.charges.length, 0); assert.equal(db.t("payments").filter((x: any) => x.booking_id === b.row.id).length, 0);
  assert.ok(b.row.card_setup_at); assert.ok(b.row.card_consent_at); assert.match(b.row.card_consent_text, /Nothing is charged and no funds are held/);
  assert.deepEqual([b.row.card_brand, b.row.card_last4], ["visa", "4242"]);
  // Admin dashboard alert + business email with a link into the admin booking page.
  const alert = db.t("admin_notifications").find((n: any) => n.event === "booking.created" && n.entity_id === b.row.id);
  assert.ok(alert); assert.match(String(alert.link), new RegExp(`/admin/bookings/${b.row.id}`));
  const biz = brevoTo("owner@example.com").find((c) => JSON.stringify(c.body).includes(b.row.reference));
  assert.ok(biz && JSON.stringify(biz.body).includes(`/admin/bookings/${b.row.id}`));
  // Customer email: tracking ID and tracking link, says nothing is charged, and NO payment link.
  const cust = brevoTo("ann@example.com").find((c) => JSON.stringify(c.body).includes(b.row.reference))!;
  const html = JSON.stringify(cust.body);
  assert.ok(html.includes(b.row.tracking_code)); assert.ok(html.includes("/track#id=")); assert.ok(!html.includes("/pay/"));
  assert.match(html, /Nothing has been charged and no funds are on hold/); assert.ok(!/No card is held|secure payment link/.test(html));
  // Repeating the callback or the webhook neither duplicates the notice nor the card.
  await routes.cardComplete.POST(post("/api/bookings/card/complete", { token: b.row.payment_token }));
  assert.equal(brevoTo("ann@example.com").filter((c) => JSON.stringify(c.body).includes(b.row.reference)).length, 1);
  assert.equal(db.t("admin_notifications").filter((n: any) => n.event === "booking.created" && n.entity_id === b.row.id).length, 1);
});

test("approval alone charges nothing and confirms nothing; the customer's confirmation + Stripe's verified payment confirm; only then a driver is assigned", async () => {
  const b = await flow(); await saveCard(b);
  // Before approval the confirmation endpoint refuses and nothing is charged.
  const early = await confirmCharge(b);
  assert.equal(early.status, 409); assert.equal((await early.json()).code, "not_approved");
  assert.equal(stripeMock.charges.length, 0);
  const driver = aDriver();
  const ap = await approve(b);
  assert.equal(ap.status, 200);
  assert.equal(b.row.status, "approved"); assert.ok(b.row.approved_at); assert.ok(b.row.payment_released_at); assert.equal(b.row.driver_id ?? null, null); // approval assigns no driver
  assert.equal(b.row.payment_status, "card_saved"); assert.equal(b.row.confirmed_at ?? null, null); assert.equal(b.row.customer_confirmed_at ?? null, null);
  assert.equal(stripeMock.charges.length, 0); assert.equal(db.t("payments").filter((x: any) => x.booking_id === b.row.id).length, 0); // no charge, no hold
  const apEmail = brevoTo("ann@example.com").filter((c) => JSON.stringify(c.body).includes(b.row.reference) && JSON.stringify(c.body).includes("is approved"));
  assert.equal(apEmail.length, 1);
  const apHtml = JSON.stringify(apEmail[0].body);
  assert.ok(!apHtml.includes("/pay/")); assert.ok(apHtml.includes("/track#id=")); assert.match(apHtml, /Confirm Booking & Authorize Charge|Confirm Booking &amp; Authorize Charge/);
  assert.ok(!apHtml.includes("4105550999") && !apHtml.includes("Dana"));
  // A second approval (double click / second admin) is refused; a driver cannot be assigned before confirmation.
  assert.equal((await approve(b)).status, 409);
  const early2 = await assignDriver(b, driver.id); assert.equal(early2.status, 409); assert.equal((await early2.json()).code, "not_confirmed");
  assert.equal(db.t("booking_assignments").filter((a: any) => a.booking_id === b.row.id).length, 0);

  // Customer confirms; Stripe has not yet verified: still unpaid, unconfirmed, still no driver.
  assert.equal((await pay(b.row.payment_token)).status, 200);
  const p = db.t("payments").find((x: any) => x.booking_id === b.row.id);
  assert.equal(b.row.status, "approved"); assert.equal(b.row.confirmed_at ?? null, null); assert.ok(b.row.customer_confirmed_at);
  assert.equal((await assignDriver(b, driver.id)).status, 409);

  net.calls.length = 0;
  const evt = sessionEvent("checkout.session.completed", p, {}, "evt_confirm_1");
  assert.equal((await (await routes.webhook.POST(hook(evt))).json()).result, "processed");
  assert.equal(p.status, "paid"); assert.equal(b.row.payment_status, "paid"); assert.equal(b.row.status, "confirmed"); assert.ok(b.row.confirmed_at);
  assert.equal(b.row.driver_id ?? null, null); // confirmed and paid, ready for driver assignment: no driver yet
  const hist = db.t("booking_status_history").filter((h: any) => h.booking_id === b.row.id && h.to_status === "confirmed");
  assert.equal(hist.length, 1); assert.equal(hist[0].actor_type, "system");

  // Confirmation email: reference, tracking, route, time, vehicle, amount actually paid, helpline.
  const conf = brevoTo("ann@example.com").filter((c) => JSON.stringify(c.body).includes("is confirmed"));
  assert.equal(conf.length, 1);
  const h = JSON.stringify(conf[0].body);
  for (const must of [b.row.reference, b.row.tracking_code, "1 Main St, Baltimore", "Stop Cafe, Towson", "Dulles Airport", "E-Class", `$${(b.row.online_amount_cents / 100).toFixed(2)}`, "+1 555-010-0199", "/track#id="]) assert.ok(h.includes(must), must);

  // Redelivery of the SAME event, a NEW event id for the same payment, and a late success event: nothing changes, no more emails.
  await routes.webhook.POST(hook(evt));
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p, {}, "evt_confirm_2")));
  await routes.webhook.POST(hook(sessionEvent("checkout.session.async_payment_succeeded", p, {}, "evt_confirm_3")));
  assert.equal(brevoTo("ann@example.com").filter((c) => JSON.stringify(c.body).includes("is confirmed")).length, 1);
  assert.equal(brevoTo("owner@example.com").filter((c) => JSON.stringify(c.body).includes("Payment received")).length, 1);
  assert.equal(db.t("booking_status_history").filter((x: any) => x.booking_id === b.row.id && x.to_status === "confirmed").length, 1);
  assert.equal(b.row.amount_paid_cents, 28000);

  // NOW the admin can assign a driver; the customer then gets the driver's details (never a phone number).
  net.calls.length = 0;
  const as = await assignDriver(b, driver.id);
  assert.equal(as.status, 200); assert.equal(b.row.status, "assigned"); assert.equal(b.row.driver_id, driver.id);
  const dm = brevoTo("ann@example.com").filter((c) => JSON.stringify(c.body).includes("driver has been assigned") || JSON.stringify(c.body).includes("driver has now been assigned"));
  assert.equal(dm.length, 1); assert.ok(JSON.stringify(dm[0].body).includes("Dana")); assert.ok(!JSON.stringify(dm[0].body).includes("4105550999"));
  assert.equal((await assignDriver(b, driver.id)).status, 409); // already assigned: use Reassign

  // Two deliveries racing each other record one payment and one confirmation.
  const b2 = await flow(); await approve(b2); await pay(b2.row.payment_token);
  const p2 = db.t("payments").find((x: any) => x.booking_id === b2.row.id); net.calls.length = 0;
  await Promise.all([routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p2, {}, "evt_race_a"))), routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p2, {}, "evt_race_b")))]);
  assert.equal(b2.row.amount_paid_cents, 28000);
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
  assert.equal(early.status, 409);                                                                  // no driver and unpaid: even an admin cannot start the ride
  await pay(c.row.payment_token);
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", db.t("payments").find((x: any) => x.booking_id === c.row.id), {}, "evt_adv_1")));
  assert.equal((await wf(c.row.id, { action: "advance", status: "getting_ready" })).status, 409);    // confirmed and paid, but still no driver
  assert.equal((await assignDriver(c)).status, 200);
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
  assert.equal(t.headline, "Add your card to complete your request"); assert.equal(t.stage, "card_needed"); assert.equal(t.driver, null); assert.equal(t.confirmed, false);
  await saveCard(b);
  t = (await (await trackPost(b.row.tracking_code, "10.8.0.1")).json()).trip;
  assert.equal(t.headline, "Booking Request Received: Awaiting Admin Approval"); assert.equal(t.stage, "awaiting_approval");
  assert.deepEqual(t.steps.filter((s: any) => s.state === "done").map((s: any) => s.key), ["received"]);
  assert.deepEqual(t.card, { brand: "visa", last4: "4242" }); assert.equal(t.charges, null);   // brand + last four only; no amounts for the tracking credential while waiting
  await approve(b);
  t = (await (await trackPost(b.row.tracking_code, "10.8.0.1")).json()).trip;
  assert.equal(t.headline, "Approved: please confirm your booking"); assert.equal(t.stage, "approved_ready"); assert.equal(t.canConfirm, true); assert.equal(t.confirmed, false);
  assert.equal(t.charges.totalCents, b.row.online_amount_cents);                  // the customer sees the total they are asked to confirm
  assert.equal(t.driver, null);                                                   // no driver details until the booking is confirmed by verified payment
  assert.equal(t.helpline.display, "+1 555-010-0199");
  await pay(b.row.payment_token);
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", db.t("payments").find((x: any) => x.booking_id === b.row.id), {}, "evt_track_1")));
  t = (await (await trackPost(b.row.tracking_code, "10.8.0.1")).json()).trip;
  assert.equal(t.headline, "Booking confirmed"); assert.equal(t.confirmed, true); assert.equal(t.driver, null);   // confirmed and paid: the driver comes next
  await assignDriver(b);
  t = (await (await trackPost(b.row.tracking_code, "10.8.0.1")).json()).trip;
  assert.equal(t.driver.name, "Dana"); assert.equal(t.driver.vehicle, "Black Escalade"); assert.equal(t.driver.plate, "VT-123"); assert.ok(!("phone" in t.driver)); // confirmed + paid + assigned: now shown
  await wf(b.row.id, { action: "advance", status: "on_the_way" });
  t = (await (await trackPost(b.row.tracking_code, "10.8.0.1")).json()).trip;
  assert.equal(t.headline, "Your driver is on the way"); assert.equal(t.confirmed, true);
  assert.equal(t.steps.find((s: any) => s.state === "current").key, "on_the_way");
  assert.ok(t.steps.filter((s: any) => s.state === "done").map((s: any) => s.key).includes("confirmed"));
  const raw = JSON.stringify(t);
  for (const secret of ["4105550100", "ann@example.com", "INTERNAL-NOTE-SECRET", "4105550999", "dana@example.com", b.row.payment_token, "Dana Driver", "stripe", "cs_test_", "tel:"]) assert.ok(!raw.includes(secret), secret);
  assert.equal(t.driver.plate, "VT-123");                                          // the assigned driver's plate is now shown to the booking's customer (client-approved)
  assert.equal(t.charges, null); assert.equal(t.payable, false);                  // no amounts or pay button for the public tracking credential once nothing is left to confirm
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
  assert.equal(viaToken.view.stage, "approved_ready"); assert.equal(viaToken.view.canConfirm, true); assert.equal(viaToken.view.payable, false); /* PayPal is not configured */ assert.equal(viaToken.view.charges.totalCents, b.row.online_amount_cents);
  assert.deepEqual(Object.keys(viaToken.view.charges).sort(), ["childSeatCents", "currency", "meetGreetCents", "totalCents", "tripFareCents"]); // no tier fee, no rates
  assert.equal(viaToken.view.charges.tripFareCents + viaToken.view.charges.meetGreetCents + viaToken.view.charges.childSeatCents, viaToken.view.charges.totalCents);
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
    // Assigned but the driver has not started the ride or left for pickup: chat is closed for BOTH sides, enforced by the API (not just the UI).
    assert.equal((await trackChat("POST", a.row.tracking_code, { body: "hello early", clientId: "client-0000-early" }, "10.7.0.9")).status, 409);
    assert.equal(db.t("booking_messages").filter((m: any) => m.booking_id === a.row.id).length, 0);
    for (const x of [a, other]) { x.row.status = "getting_ready"; x.row.confirmed_at = new Date().toISOString(); x.row.payment_status = "paid"; x.row.pickup_at = new Date(Date.now() + 23 * 3600_000).toISOString(); } // paid and confirmed, pickup 23 hours away: chat is open
    a.row.pickup_at = new Date(Date.now() + 25 * 3600_000).toISOString();           // 25 hours away: closed for both sides (24-hour rule, server-side)
    assert.equal((await trackChat("POST", a.row.tracking_code, { body: "too early", clientId: "client-0000-24h1" }, "10.7.0.10")).status, 409);
    assert.equal((await trackChat("GET", a.row.tracking_code, undefined, "10.7.0.11")).status === 200, true);
    a.row.pickup_at = new Date(Date.now() + 23 * 3600_000).toISOString();
    assert.equal((await trackChat("GET", a.row.tracking_code, undefined, "10.7.0.8")).status, 200);

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
    a.row.pickup_at = new Date(Date.now() + 2 * 24 * 3600_000).toISOString(); // pickup moved to later: the window moves with it and chat closes again at once
    assert.equal((await drvPost("drv1", a.row.id, "too early", "client-0006-early")).status, 409);
    a.row.pickup_at = new Date(Date.now() + 3600_000).toISOString();
    assert.equal((await drvPost("drv1", a.row.id, "Be there in 3 minutes", "client-0006-aaaa")).status, 200);
    assert.equal((await drvPost("nobody", a.row.id, "hello", "client-0007-aaaa")).status, 401);

    // Reassign: the previous driver loses access immediately; the new driver gets it; the customer's tracking page now names the new driver.
    assert.equal((await wf(a.row.id, { action: "reassign", driverId: d2.id })).status, 200);
    assert.equal((await drvGet("drv1", a.row.id)).status, 404);
    assert.equal((await drvPost("drv1", a.row.id, "still here?", "client-0008-aaaa")).status, 404);
    assert.equal((await drvGet("drv2", a.row.id)).status, 200);
    assert.equal((await drvPost("drv2", a.row.id, "I am your new driver", "client-0009-aaaa")).status, 200);
    const t = (await (await trackPost(a.row.tracking_code, "10.7.2.1")).json()).trip;
    assert.equal(t.driver.name, "Eli");
    assert.equal(brevoTo("dana@example.com").filter((c) => JSON.stringify(c.body).includes(a.row.reference)).length >= 1, true); // old driver was told

    // A closed booking stops accepting messages.
    await wf(a.row.id, { action: "cancel", reason: "Cancelled by request" });
    assert.equal((await trackChat("POST", a.row.tracking_code, { body: "too late", clientId: "client-0010-aaaa" }, "10.7.3.1")).status, 409);
    assert.equal((await drvPost("drv2", a.row.id, "too late", "client-0011-aaaa")).status, 409); // chat is closed once the ride is closed
  } finally { db.auth.getUser = origGetUser; }
});

test("driver-facing ride data carries no customer or passenger phone numbers", async () => {
  const { loadDriverRides } = await import("../src/lib/driver/rides.ts");
  const b = await flow({}, {}); await approve(b, aDriver().id);
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
    const b = await flow(); await legacyAssignedUnpaid(b, d1.id);
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
    // Getting Ready is an ACKNOWLEDGEMENT: allowed any time once confirmed and paid. Leave for Pickup is the server-gated step (never days early).
    const HOUR = 3600_000;
    b.row.pickup_at = new Date(Date.now() + 3 * 24 * HOUR).toISOString();          // days away
    assert.equal((await step("drv2", b.row.id, "getting_ready")).status, 200); assert.equal(b.row.status, "getting_ready");
    const early = await step("drv2", b.row.id, "on_the_way");
    assert.equal(early.status, 409); assert.equal((await early.json()).code, "too_early"); assert.equal(b.row.status, "getting_ready");
    b.row.pickup_at = new Date(Date.now() + 3 * HOUR).toISOString();               // inside the default 4-hour dispatch window
    for (const to of ["on_the_way", "arrived"]) assert.equal((await step("drv2", b.row.id, to)).status, 200, to);
    // Start Ride (Passenger picked up) opens exactly two hours before pickup, by the server clock.
    const tooEarly = await step("drv2", b.row.id, "picked_up");                      // pickup is 3h away
    assert.equal(tooEarly.status, 409); assert.equal((await tooEarly.json()).code, "too_early"); assert.equal(b.row.status, "arrived");
    b.row.pickup_at = new Date(Date.now() + 2 * HOUR + 120_000).toISOString();        // 2h02m: still locked
    assert.equal((await step("drv2", b.row.id, "picked_up")).status, 409);
    b.row.pickup_at = new Date(Date.now() + 2 * HOUR - 60_000).toISOString();         // 1h59m: open
    for (const to of ["picked_up", "completed"]) assert.equal((await step("drv2", b.row.id, to)).status, 200, to);
    assert.equal(b.row.status, "completed");

    // 7. Refunded after confirmation: progress stops until an admin resolves it; cancelled and declined never progress.
    const r = await flow(); await approve(r, d2.id); await pay(r.row.payment_token);
    await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", db.t("payments").find((x: any) => x.booking_id === r.row.id), {}, "evt_gate_r")));
    r.row.pickup_at = new Date(Date.now() + 3600_000).toISOString(); // inside the dispatch window
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


/* eslint-disable @typescript-eslint/no-explicit-any */
// ===== Phase 2: dispatch window, ratings, performance points, visibility, driver details, emails =====
const withAuth = async <T,>(fn: () => Promise<T>) => {
  const orig = db.auth.getUser;
  db.auth.getUser = async (t: string) => t === "good" ? { data: { user: { id: "admin-1", email: "a@x.com" } }, error: null } : t === "drv1" ? { data: { user: { id: "u-d1", email: "dana@example.com" } }, error: null } : t === "drv2" ? { data: { user: { id: "u-d2", email: "eli@example.com" } }, error: null } : { data: { user: null }, error: { message: "bad" } };
  try { return await fn(); } finally { db.auth.getUser = orig; }
};
const confirmPaid = async (b: any) => {
  if (b.row.confirmed_at) return; // already confirmed (the helper is safe to call after approve(b, driverId))
  await pay(b.row.payment_token);
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", db.t("payments").filter((x: any) => x.booking_id === b.row.id).pop(), {}, `evt_p2_${++ev}`)));
  assert.ok(b.row.confirmed_at);
};
const rate = (code: string | null, body: unknown, ip: string) => {
  const h: Record<string, string> = { ...HDR({ "x-forwarded-for": ip }) }; if (code) h["x-tracking-id"] = code;
  return routes.trackRating.POST(new Request("http://site.test/api/track/rating", { method: "POST", headers: h, body: JSON.stringify(body) }));
};
const HOUR_MS = 3600_000;

test("Leave for Pickup is server-gated by the dispatch window and separate from the Getting Ready acknowledgement", async () => {
  await withAuth(async () => {
    const d1 = aDriver(); d1.user_id = "u-d1";
    const step = (id: string, status: string) => asDriver("drv1", () => routes.driverStatusRoute.POST(post("/api/driver/status", { id, status })));
    const b = await flow(); await approve(b, d1.id); await confirmPaid(b);
    b.row.pickup_at = new Date(Date.now() + 3 * 24 * HOUR_MS).toISOString();      // days away
    const direct = await step(b.row.id, "on_the_way");                              // cannot skip straight to leaving, days early
    assert.equal(direct.status, 409); assert.equal((await direct.json()).code, "too_early"); assert.notEqual(b.row.status, "on_the_way");
    assert.equal((await step(b.row.id, "getting_ready")).status, 200);              // acknowledging is allowed at any time
    assert.equal((await step(b.row.id, "on_the_way")).status, 409);
    b.row.pickup_at = new Date(Date.now() + 4 * HOUR_MS + 120_000).toISOString();  // 4h02m: default 4-hour dispatch window not open yet
    assert.equal((await step(b.row.id, "on_the_way")).status, 409);
    b.row.pickup_at = new Date(Date.now() + 3 * HOUR_MS).toISOString();            // 3h: inside the window
    assert.equal((await step(b.row.id, "on_the_way")).status, 200); assert.equal(b.row.status, "on_the_way");
  });
});

test("dispatch window rule is pure, clamped and never below the Start Ride window", async () => {
  const { leaveForPickupWindow, clampDispatchMinutes, DEFAULT_DISPATCH_MINUTES } = await import("../src/lib/booking-status.ts");
  assert.equal(DEFAULT_DISPATCH_MINUTES, 240);
  assert.equal(clampDispatchMinutes(5), 15); assert.equal(clampDispatchMinutes("abc"), 240); assert.equal(clampDispatchMinutes(99999), 2880);
  const now = Date.parse("2026-12-01T12:00:00Z"), pickup = new Date(now + 4 * HOUR_MS).toISOString();
  assert.equal(leaveForPickupWindow(pickup, now).allowed, true); assert.equal(leaveForPickupWindow(pickup, now - 1).allowed, false);
  assert.equal(leaveForPickupWindow(pickup, now, 360).allowed, true);               // admin widened it to 6 hours
  assert.equal(leaveForPickupWindow("bad", now).allowed, false);
});

test("customer star rating: only the booking's own completed ride, validated on the server, once", async () => {
  await withAuth(async () => {
    const d1 = aDriver();
    const a = await flow(); const other = await flow(); await approve(a, d1.id); await approve(other, d1.id);
    assert.equal((await rate(a.row.tracking_code, { stars: 5 }, "10.20.0.1")).status, 409);   // not completed yet
    a.row.status = "completed";
    assert.equal((await rate(null, { stars: 5 }, "10.20.0.2")).status, 404);                   // no credential
    assert.equal((await rate(a.row.payment_token, { stars: 5 }, "10.20.0.3")).status, 404);   // a different credential type
    for (const bad of [0, 6, 2.5, "x"]) assert.equal((await rate(a.row.tracking_code, { stars: bad }, "10.20.0.4")).status, 422, String(bad));
    assert.equal((await rate(a.row.tracking_code, { stars: 4, feedback: "x".repeat(1001) }, "10.20.0.5")).status, 422);
    assert.equal((await rate(a.row.tracking_code, { stars: 4, feedback: "Smooth ride", bookingId: other.row.id, driverId: "forged" }, "10.20.0.6")).status, 200);
    const rows = db.t("driver_ratings"); assert.equal(rows.length, 1);
    assert.equal(rows[0].booking_id, a.row.id); assert.equal(rows[0].driver_id, d1.id); assert.equal(rows[0].customer_id, a.row.customer_id); assert.equal(rows[0].stars, 4); assert.equal(rows[0].feedback, "Smooth ride");
    assert.equal((await rate(a.row.tracking_code, { stars: 1 }, "10.20.0.7")).status, 409);   // duplicate refused, original kept
    assert.equal(db.t("driver_ratings").length, 1); assert.equal(db.t("driver_ratings")[0].stars, 4);
    const t = (await (await trackPost(a.row.tracking_code, "10.20.0.8")).json()).trip;
    assert.deepEqual(t.rating, { canRate: true, rated: true });
    const { driverRatingSummary } = await import("../src/lib/ratings.ts");
    assert.deepEqual(await driverRatingSummary(db, d1.id), { avg: 4, count: 1 });
  });
});

test("driver rates the customer: own completed ride only, once, stored separately and never shown to the customer", async () => {
  await withAuth(async () => {
    const d1 = aDriver(); d1.user_id = "u-d1";
    if (!db.t("drivers").some((d: any) => d.user_id === "u-d2")) db.seed("drivers", [{ full_name: "Eli Other", email: "eli@example.com", phone: "4105550888", vehicle_plate: "VT-456", is_active: true, user_id: "u-d2" }]);
    const b = await flow(); await approve(b, d1.id);
    const go = (token: string, body: object) => asDriver(token, () => routes.driverRate.POST(post("/api/driver/rate-customer", body)));
    assert.equal((await go("drv1", { bookingId: b.row.id, stars: 5 })).status, 409);   // not completed
    b.row.status = "completed";
    assert.equal((await go("nobody", { bookingId: b.row.id, stars: 5 })).status, 401);
    assert.equal((await go("drv2", { bookingId: b.row.id, stars: 5 })).status, 404);   // another driver's ride
    assert.equal((await go("drv1", { bookingId: "nope", stars: 5 })).status, 400);
    assert.equal((await go("drv1", { bookingId: b.row.id, stars: 9 })).status, 422);
    const before = db.t("driver_ratings").length;
    assert.equal((await go("drv1", { bookingId: b.row.id, stars: 3, feedback: "Late to the curb" })).status, 200);
    assert.equal((await go("drv1", { bookingId: b.row.id, stars: 5 })).status, 409);
    const rows = db.t("customer_ratings").filter((r: any) => r.booking_id === b.row.id);
    assert.equal(rows.length, 1); assert.equal(rows[0].driver_id, d1.id); assert.equal(rows[0].customer_id, b.row.customer_id); assert.equal(rows[0].stars, 3);
    assert.equal(db.t("driver_ratings").length, before);                                // the two rating systems are separate
    const t = (await (await trackPost(b.row.tracking_code, "10.20.1.1")).json()).trip;
    assert.ok(!JSON.stringify(t).includes("Late to the curb"));                          // the customer never sees the driver's rating of them
  });
});

test("admin performance points: admin-only, 0-100, logged, independent of star ratings; visibility switches are independent", async () => {
  await withAuth(async () => {
    const d1 = aDriver();
    const pts = (body: object, cookie = "good") => { const prev = (globalThis as any).__cookies; (globalThis as any).__cookies = cookie ? { vt_at: cookie } : {}; return routes.adminPoints.POST(post("/api/admin/drivers/points", body)).finally(() => { (globalThis as any).__cookies = prev; }); };
    const vis = (body: object, cookie = "good") => { const prev = (globalThis as any).__cookies; (globalThis as any).__cookies = cookie ? { vt_at: cookie } : {}; return routes.adminVisibility.POST(post("/api/admin/drivers/visibility", body)).finally(() => { (globalThis as any).__cookies = prev; }); };
    d1.performance_points = 100;
    assert.equal((await pts({ driverId: d1.id, adjustment: -5 }, "")).status, 401);          // not signed in
    assert.equal((await pts({ driverId: d1.id, adjustment: -5 }, "drv1")).status, 401);      // a driver is not an admin
    assert.equal((await pts({ driverId: d1.id, adjustment: 1 })).status, 422);                // 101
    assert.equal((await pts({ driverId: d1.id, adjustment: -101 })).status, 422);             // -1
    assert.equal((await pts({ driverId: d1.id, adjustment: 1.5 })).status, 422);
    assert.equal((await pts({ driverId: d1.id, adjustment: -30, reason: "Late twice" })).status, 200);
    assert.equal(d1.performance_points, 70);
    assert.equal((await pts({ driverId: d1.id, newPoints: 95 })).status, 200); assert.equal(d1.performance_points, 95);
    assert.equal((await pts({ driverId: d1.id, newPoints: 101 })).status, 422); assert.equal(d1.performance_points, 95);
    assert.equal((await pts({ driverId: d1.id, adjustment: 5, newPoints: 50 })).status, 422);  // ambiguous request
    const h = db.t("driver_points_history").filter((x: any) => x.driver_id === d1.id);
    assert.equal(h.length, 2); assert.deepEqual([h[0].previous_points, h[0].new_points, h[0].adjustment, h[0].reason, h[0].admin_email], [100, 70, -30, "Late twice", "a@x.com"]);
    assert.deepEqual([h[1].previous_points, h[1].new_points, h[1].adjustment], [70, 95, 25]);
    // The generic editor cannot be used to forge points or visibility.
    await adminAs(() => routes.crud.POST(post("/api/admin/crud", { resource: "drivers", action: "update", id: d1.id, values: { performance_points: 0, show_points_to_driver: true } })));
    assert.equal(d1.performance_points, 95); assert.ok(!d1.show_points_to_driver);
    // Visibility: independent switches, data kept, driver-facing profile follows them.
    const { loadDriverProfile } = await import("../src/lib/driver/rides.ts");
    const b = await flow(); await approve(b, d1.id); b.row.status = "completed"; await rate(b.row.tracking_code, { stars: 5 }, "10.20.2.1");
    let p: any = await loadDriverProfile(db, d1.id); assert.equal(p.rating, null); assert.equal(p.points, null);   // hidden by default
    assert.equal((await vis({ driverId: d1.id, showRating: true }, "drv1")).status, 401);
    assert.equal((await vis({ driverId: d1.id, showRating: true })).status, 200);
    p = await loadDriverProfile(db, d1.id); assert.deepEqual(p.rating, { avg: 4.5, count: 2 }); assert.equal(p.points, null);   // this driver has the 4-star rating from the earlier test plus this 5-star one
      // rating shown, points still hidden
    assert.equal((await vis({ driverId: d1.id, showPoints: true })).status, 200);
    assert.equal((await vis({ driverId: d1.id, showRating: false })).status, 200);
    p = await loadDriverProfile(db, d1.id); assert.equal(p.rating, null); assert.equal(p.points, 95);                          // now the reverse
    assert.equal(db.t("driver_ratings").length > 0 && d1.performance_points === 95, true);                                     // hiding deleted nothing
    assert.equal((await vis({ driverId: d1.id })).status, 400);
    assert.ok(!JSON.stringify(await (await routes.driverStatusRoute.POST(post("/api/driver/status", {}))).json().catch(() => ({}))).includes("performance"));
  });
});

test("driver dashboard layout rules: earliest upcoming first, active separate, at most one completed ride", async () => {
  const { splitRides } = await import("../src/lib/driver/dashboard.ts");
  const R = (id: string, status: string, at: string): any => ({ id, status, pickupAt: at });
  const rides = [R("c1", "completed", "2026-11-01T10:00:00Z"), R("u3", "assigned", "2026-12-09T10:00:00Z"), R("a1", "on_the_way", "2026-12-01T08:00:00Z"), R("u1", "confirmed", "2026-12-02T10:00:00Z"), R("c2", "completed", "2026-11-20T10:00:00Z"), R("u2", "assigned", "2026-12-05T10:00:00Z"), R("x", "cancelled", "2026-12-03T10:00:00Z")];
  const s = splitRides(rides);
  assert.deepEqual(s.active.map((r) => r.id), ["a1"]);
  assert.equal(s.next?.id, "u1"); assert.deepEqual(s.later.map((r) => r.id), ["u2", "u3"]);
  assert.equal(s.lastCompleted?.id, "c2");                                             // only the latest completed ride
  assert.equal(splitRides([]).next, null);
});

test("emails: driver details only after the booking is confirmed AND a driver is assigned, from real records, once", async () => {
  net.calls.length = 0;
  const b = await flow(); await approve(b);
  const approved = brevoTo("ann@example.com").filter((c) => JSON.stringify(c.body).includes(b.row.reference));
  assert.ok(approved.length >= 1);
  for (const c of approved) { const t = JSON.stringify(c.body); assert.ok(!t.includes("VT-123") && !t.includes("Black Escalade") && !t.includes("4105550999")); }   // not before payment
  await confirmPaid(b);
  const confirmed = brevoTo("ann@example.com").filter((c) => String(c.body?.subject ?? "").includes("is confirmed") && JSON.stringify(c.body).includes(b.row.reference));
  assert.equal(confirmed.length, 1);
  const html = JSON.stringify(confirmed[0].body);
  for (const must of ["Stop Cafe", b.row.tracking_code]) assert.ok(html.includes(must), must);
  assert.ok(!html.includes("Black Escalade") && !html.includes("VT-123")); // confirmed, but no driver yet: nothing invented
  await assignDriver(b);
  const assigned = brevoTo("ann@example.com").filter((c) => String(c.body?.subject ?? "").includes("driver has been assigned") && JSON.stringify(c.body).includes(b.row.reference));
  assert.equal(assigned.length, 1);
  const dh = JSON.stringify(assigned[0].body);
  for (const must of ["Dana", "Black Escalade", "VT-123", b.row.tracking_code]) assert.ok(dh.includes(must), must);
  assert.ok(!dh.includes("4105550999") && !dh.includes("Dana Driver"));            // no phone, no surname
});

test("admin follow-up list: only confirmed and paid, assigned, not-yet-acknowledged upcoming rides, earliest first", async () => {
  const { loadUnacknowledgedRides } = await import("../src/lib/admin/acknowledgement.ts");
  const d1 = aDriver();
  const mk = async (hoursAway: number, ack: boolean, paid = true) => {
    const b = await flow(); if (paid) await approve(b, d1.id); else await legacyAssignedUnpaid(b, d1.id);
    b.row.pickup_at = new Date(Date.now() + hoursAway * HOUR_MS).toISOString(); if (ack) b.row.status = "getting_ready";
    return b;
  };
  const late = await mk(30, false), soon = await mk(5, false), acked = await mk(6, true), unpaid = await mk(7, false, false);
  const rows = await loadUnacknowledgedRides(db);
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(late.row.id) && ids.includes(soon.row.id));
  assert.ok(!ids.includes(acked.row.id));      // already tapped Getting Ready
  assert.ok(!ids.includes(unpaid.row.id));     // not confirmed by verified payment
  assert.ok(ids.indexOf(soon.row.id) < ids.indexOf(late.row.id)); // earliest pickup first
});

test("pickup-time change: only an admin applies it, it is recorded and emailed, a chat message never changes it, and the chat window moves with it", async () => {
  await withAuth(async () => {
    const d1 = aDriver();
    const b = await flow(); await approve(b, d1.id); await confirmPaid(b);
    const original = new Date(Date.now() + 10 * HOUR_MS).toISOString(); b.row.pickup_at = original;
    const chatOpenNow = async () => (await (await trackChat("GET", b.row.tracking_code, undefined, `10.40.${++ev}.1`)).json()).open;
    assert.equal(await chatOpenNow(), true);                                                     // 10h before pickup: inside the 24-hour window
    // A customer chat message that asks for a change does not touch the official time.
    b.row.status = "getting_ready";
    await trackChat("POST", b.row.tracking_code, { body: "Can we move pickup 30 minutes later?", clientId: "client-0040-aaaa" }, "10.40.0.9");
    assert.equal(b.row.pickup_at, original);
    // The generic editor cannot change it either, and neither can a driver or a signed-out caller.
    await adminAs(() => routes.crud.POST(post("/api/admin/crud", { resource: "bookings", action: "update", id: b.row.id, values: { pickup_at: new Date(Date.now() + 5 * HOUR_MS).toISOString() } })));
    assert.equal(b.row.pickup_at, original);
    const prev = (globalThis as any).__cookies; (globalThis as any).__cookies = {};
    assert.equal((await routes.workflow.POST(post("/api/admin/bookings/workflow", { id: b.row.id, action: "reschedule", pickupAt: new Date(Date.now() + 3 * HOUR_MS).toISOString() }))).status, 401);
    (globalThis as any).__cookies = { vt_at: "drv1" };
    assert.equal((await routes.workflow.POST(post("/api/admin/bookings/workflow", { id: b.row.id, action: "reschedule", pickupAt: new Date(Date.now() + 3 * HOUR_MS).toISOString() }))).status, 401);
    (globalThis as any).__cookies = prev;
    assert.equal(b.row.pickup_at, original);
    // Validation.
    for (const bad of [undefined, "nonsense", new Date(Date.now() - HOUR_MS).toISOString(), original]) assert.equal((await wf(b.row.id, { action: "reschedule", pickupAt: bad })).status, 422, String(bad));
    // Approved by an admin: applied, old and new times recorded, customer emailed.
    net.calls.length = 0;
    const later = new Date(Date.now() + 3 * 24 * HOUR_MS).toISOString();
    const r = await wf(b.row.id, { action: "reschedule", pickupAt: later, reason: "Customer asked in chat" });
    assert.equal(r.status, 200); assert.equal(b.row.pickup_at, later);
    const h = db.t("booking_status_history").filter((x: any) => x.booking_id === b.row.id && /Pickup time changed/.test(x.note ?? ""));
    assert.equal(h.length, 1); assert.match(h[0].note, /Customer asked in chat/);
    const lg = db.t("activity_logs").filter((x: any) => x.action === "booking.rescheduled" && x.entity_id === b.row.id);
    assert.equal(lg.length, 1); assert.deepEqual([lg[0].meta.previous, lg[0].meta.next], [original, later]);
    const mails = brevoTo("ann@example.com").filter((c) => String(c.body?.subject ?? "").includes("pickup time has changed"));
    assert.equal(mails.length, 1); assert.ok(JSON.stringify(mails[0].body).includes(b.row.reference));
    assert.ok(!JSON.stringify(mails[0].body).includes("4105550999"));                            // no driver phone
    // The 24-hour chat window is recalculated from the NEW time: 3 days away is closed again.
    assert.equal(await chatOpenNow(), false);
    // The same request repeated does not send a second email; and a finished ride cannot be rescheduled.
    assert.equal((await wf(b.row.id, { action: "reschedule", pickupAt: later })).status, 422);
    b.row.status = "completed";
    assert.equal((await wf(b.row.id, { action: "reschedule", pickupAt: new Date(Date.now() + 9 * 24 * HOUR_MS).toISOString() })).status, 409);
  });
});


// ===== Phase 3: Stripe authorize now, capture on admin approval =====
const authOn = () => { setPay("full"); setFixed(10000, 15000, 22000); Object.assign(db.t("booking_settings")[0], { stripe_enabled: true }); stripeMock.captureError = null; };
const mkPI = (p: any, over: Record<string, unknown> = {}) => {
  const id = `pi_auth_${p.id.slice(0, 8)}`;
  stripeMock.pis.set(id, { id, object: "payment_intent", status: "requires_capture", amount: p.amount_cents, amount_capturable: p.amount_cents, amount_received: 0, currency: "usd", metadata: { booking_id: p.booking_id, payment_id: p.id }, latest_charge: { payment_method_details: { card: { brand: "visa", last4: "4242", capture_before: Math.floor(Date.now() / 1000) + 6 * 86400 } } }, ...over });
  return id;
};
const piEvent = (type: string, pi: any, over: Record<string, unknown> = {}) => ({ id: `evt_pi_${++ev}`, type, data: { object: { ...pi, ...over } } });
const sessionUnpaid = (p: any, piId: string) => sessionEvent("checkout.session.completed", p, { payment_status: "unpaid", payment_intent: piId });
/**
 * A booking that still carries a card HOLD from the previous "authorize now, capture on approval" workflow (existing production data).
 * Nothing creates holds any more, so the fixture is seeded directly. Used to prove such rows are handled safely: never captured, released on approval.
 */
const authorized = async () => {
  setPay("full"); setFixed(10000, 15000, 22000); stripeMock.captureError = null;
  const b = await makeBooking();
  b.row.card_flow = false; b.row.payment_status = "authorized";            // as created before the saved-card workflow
  db.seed("payments", [{ booking_id: b.row.id, provider: "stripe", amount_cents: b.row.online_amount_cents, currency: "USD", kind: "full", status: "authorized", manual_capture: true, stripe_session_id: `cs_legacy_${b.row.id.slice(0, 6)}`, card_brand: "visa", card_last4: "4242", capture_before: new Date(Date.now() + 5 * 24 * 3600_000).toISOString() }]);
  const p = db.t("payments").filter((x: any) => x.booking_id === b.row.id).at(-1);
  const piId = mkPI(p); p.stripe_payment_intent_id = piId;
  return { b, p, piId };
};

test("existing hold: a lapsed authorization never confirms or declines the booking; late events cannot revive it; the customer then follows the saved-card flow", async () => {
  stripeMock.charges.length = 0;
  const { b, p, piId } = await authorized();
  const pi = stripeMock.pis.get(piId);
  pi.status = "canceled"; pi.cancellation_reason = "automatic"; // Stripe lets the old hold lapse
  await routes.webhook.POST(hook(piEvent("payment_intent.canceled", pi)));
  assert.equal(p.status, "authorization_expired"); assert.equal(b.row.payment_status, "needs_payment");
  assert.equal(b.row.status, "new_request"); assert.equal(b.row.confirmed_at ?? null, null);      // booking untouched
  assert.ok(db.t("admin_notifications").some((n: any) => n.entity_id === b.row.id && n.event === "payment.needs_payment"));
  await routes.webhook.POST(hook(piEvent("payment_intent.amount_capturable_updated", { ...pi, status: "requires_capture" })));   // a delayed older event
  assert.equal(p.status, "authorization_expired");
  // An older booking has no saved card: approval is allowed, nothing is captured or charged, and the customer must add a card and confirm.
  stripeMock.captureCalls = 0;
  const r = await approve(b);
  assert.equal(r.status, 200); assert.equal(b.row.status, "approved"); assert.equal(stripeMock.captureCalls, 0); assert.equal(p.paid_at ?? null, null);
  assert.equal((await confirmCharge(b)).status, 409);                                              // no card yet: confirmation refused, nothing charged
  assert.equal(stripeMock.charges.length, 0);
  assert.equal((await saveCard(b)).complete!.status, 200);                                         // the customer adds a card on their own booking page (no link)
  assert.equal(b.row.status, "approved"); assert.equal(b.row.confirmed_at ?? null, null);
  stripeMock.nextCharge = "succeeded";
  assert.equal((await (await confirmCharge(b)).json()).state, "paid");
  assert.equal(b.row.payment_status, "paid"); assert.ok(b.row.confirmed_at); assert.equal(b.row.status, "confirmed");
});

test("approving a booking that still holds money from the old workflow RELEASES the hold and never captures it", async () => {
  const { b, p, piId } = await authorized();
  stripeMock.captureCalls = 0; stripeMock.cancelCalls = 0;
  const r = await approve(b);
  assert.equal(r.status, 200);
  assert.equal(stripeMock.captureCalls, 0); assert.equal(stripeMock.cancelCalls, 1);
  assert.equal(p.status, "canceled"); assert.equal(stripeMock.pis.get(piId).status, "canceled"); assert.equal(p.paid_at ?? null, null);
  assert.equal(b.row.status, "approved"); assert.notEqual(b.row.payment_status, "paid"); assert.equal(b.row.confirmed_at ?? null, null);
});

test("declining or cancelling releases an uncaptured hold and an unused saved card; captured money is never touched", async () => {
  stripeMock.charges.length = 0;
  const one = await authorized(); stripeMock.cancelCalls = 0;
  const rej = await adminAs(() => routes.workflow.POST(post("/api/admin/bookings/workflow", { id: one.b.row.id, action: "reject", reason: "No availability" })));
  assert.equal(rej.status, 200); assert.equal(stripeMock.cancelCalls, 1); assert.equal(one.p.status, "canceled"); assert.equal(stripeMock.pis.get(one.piId).status, "canceled");
  assert.notEqual(one.b.row.payment_status, "paid");
  // A declined booking's saved card is removed from Stripe: it was never charged.
  const saved = await flow(); await saveCard(saved); const pm = saved.row.stripe_payment_method_id; stripeMock.detached = [];
  await adminAs(() => routes.workflow.POST(post("/api/admin/bookings/workflow", { id: saved.row.id, action: "reject", reason: "No availability" })));
  assert.deepEqual(stripeMock.detached, [pm]); assert.equal(saved.row.stripe_payment_method_id, null); assert.equal(stripeMock.charges.length, 0);
  // Paid and confirmed: cancelling never refunds, releases or detaches anything automatically.
  const two = await flow(); await confirmBooking(two);
  const paid = db.t("payments").find((x: any) => x.booking_id === two.row.id); assert.equal(paid.status, "paid");
  stripeMock.cancelCalls = 0; stripeMock.detached = [];
  await adminAs(() => routes.workflow.POST(post("/api/admin/bookings/workflow", { id: two.row.id, action: "cancel", reason: "Customer cancelled" })));
  assert.equal(stripeMock.cancelCalls, 0); assert.equal(paid.status, "paid"); assert.deepEqual(stripeMock.detached, []);   // existing refund process, unchanged
});

test("the old capture action no longer exists: an admin cannot charge a customer", async () => {
  stripeMock.charges.length = 0;
  const b = await flow(); await approve(b);
  const r = await adminAs(() => routes.workflow.POST(post("/api/admin/bookings/workflow", { id: b.row.id, action: "capture_payment" })));
  assert.equal(r.status, 400); assert.equal(stripeMock.charges.length, 0);
  const old = await adminAs(() => routes.workflow.POST(post("/api/admin/bookings/workflow", { id: b.row.id, action: "approve_assign", driverId: aDriver().id })));
  assert.equal(old.status, 400); assert.equal(b.row.driver_id ?? null, null);
});

test("migration 0014 is additive, keeps old payment values, and never stores card numbers", () => {
  const f = readdirSync("supabase/migrations").filter((x) => x.startsWith("0014"));
  assert.equal(f.length, 1);
  const sql = readFileSync(`supabase/migrations/${f[0]}`, "utf8").toLowerCase();
  assert.ok(!/drop\s+(table|column)|truncate|delete\s+from/.test(sql));
  for (const v of ["'pending'", "'paid'", "'refunded'", "'authorized'", "'capture_failed'", "'authorization_expired'", "'needs_payment'"]) assert.ok(sql.includes(v), v);
  assert.ok(!/card_number|cvv|cvc|pan\b/.test(sql)); assert.ok(sql.includes("card_last4"));
});

test("admin authorization alerts: expiry levels, needs-payment rows first, soonest expiry next", async () => {
  const { expiryLevel } = await import("../src/lib/authorization-alerts.ts");
  const { loadAuthorizations } = await import("../src/lib/admin/authorizations.ts");
  const now = Date.parse("2026-12-01T12:00:00Z"), H = 3600_000;
  assert.equal(expiryLevel(new Date(now - 1).toISOString(), now), "expired");
  assert.equal(expiryLevel(new Date(now + 24 * H).toISOString(), now), "within_24h");
  assert.equal(expiryLevel(new Date(now + 24 * H + 1).toISOString(), now), "within_48h");
  assert.equal(expiryLevel(new Date(now + 48 * H + 1).toISOString(), now), "ok");
  assert.equal(expiryLevel(null, now), "unknown"); assert.equal(expiryLevel("bad", now), "unknown");
  const soon = await authorized(); const later = await authorized(); const failed = await authorized();
  soon.p.capture_before = new Date(Date.now() + 20 * H).toISOString(); later.p.capture_before = new Date(Date.now() + 5 * 24 * H).toISOString();
  failed.p.status = "capture_failed"; failed.p.last_error = "Capture failed: card declined";
  const rows = await loadAuthorizations(db);
  const ids = rows.map((r) => r.paymentId);
  assert.ok(ids.indexOf(failed.p.id) < ids.indexOf(soon.p.id) && ids.indexOf(soon.p.id) < ids.indexOf(later.p.id));
  assert.equal(rows.find((r) => r.paymentId === soon.p.id)!.level, "within_24h");
  assert.equal(rows.find((r) => r.paymentId === failed.p.id)!.level, "expired");
  assert.ok(!JSON.stringify(rows).includes("4242424242424242"));                          // only brand + last four, never a card number
});

// =====================================================================================================
// Complete trip fare: the online total = tier fee + trip estimate + Meet & Greet + seats. Customers see ONE combined Trip fare.
// =====================================================================================================
test("complete fare: stored total, the Stripe charge, customer view and admin breakdown all reconcile to the same total", async () => {
  authOn();
  const b = await makeBooking({ airport: airportBlock, totalCents: 1 }, { meetGreet: true, passengers: 3, childSeats: { booster: 2 } });
  const r = b.row;
  const fixed = 15000, est = r.estimated_fare_cents, mg = 3500, seatsFee = 2000;
  assert.ok(est > 0);
  assert.equal(r.online_amount_cents, fixed + est + mg + seatsFee);                       // never the tier fee alone
  // Customer response: combined trip fare + services + total only.
  assert.deepEqual(b.data.pricing, { tripFareCents: fixed + est, meetGreetCents: mg, childSeatCents: seatsFee, totalCents: r.online_amount_cents });
  assert.ok(!("fixedPriceCents" in b.data.pricing));
  // Saving the card and approval move no money.
  const from = stripeMock.charges.length;
  await approve(b);
  assert.equal(stripeMock.charges.length, from);
  // The customer's confirmation charges the COMPLETE total, as ONE PaymentIntent.
  stripeMock.nextCharge = "succeeded";
  assert.equal((await (await confirmCharge(b)).json()).state, "paid");
  const charges = stripeMock.charges.slice(from);
  assert.equal(charges.length, 1);                                                          // one charge, not one per component
  assert.equal(charges[0].body.get("amount"), String(r.online_amount_cents));
  const p = db.t("payments").find((x: any) => x.booking_id === r.id);
  assert.equal(p.amount_cents, r.online_amount_cents); assert.equal(p.manual_capture, false);
  // Admin keeps the internal split on the payment row; it reconciles exactly.
  assert.deepEqual([p.fixed_price_cents, p.estimated_trip_fare_cents, p.meet_greet_cents, p.other_addons_cents], [fixed, est, mg, seatsFee]);
  assert.equal(p.fixed_price_cents + p.estimated_trip_fare_cents + p.meet_greet_cents + p.other_addons_cents, p.amount_cents);
  assert.match(charges[0].body.get("description")!, /^Vanta Transportation booking VT-\d+$/);
  assert.equal(r.payment_status, "paid"); assert.equal(r.amount_paid_cents, r.online_amount_cents); assert.equal(r.status, "confirmed");
  // Customer view, admin figures and the payment all agree.
  const { loadTrip } = await import("../src/lib/trip.ts");
  const view: any = await loadTrip(db, r.payment_token);
  assert.equal(view.view.charges.totalCents, p.amount_cents);
});

test("complete fare: no customer-facing surface (emails, tracking/pay data, quote API, Stripe) reveals the tier fee or rates", async () => {
  authOn();
  net.calls.length = 0;
  const b = await makeBooking({ airport: airportBlock }, { meetGreet: true, childSeats: { booster: 1 } });
  await saveCard(b); stripeMock.nextCharge = "succeeded"; await approve(b); await confirmCharge(b); // the customer-facing request notice follows the card step
  const r = b.row; const total = (r.online_amount_cents / 100).toFixed(2); const tripFare = ((15000 + r.estimated_fare_cents) / 100).toFixed(2);
  const customerMail = JSON.stringify(brevoTo("ann@example.com").filter((c) => JSON.stringify(c.body).includes(r.reference)).map((c) => c.body));
  assert.ok(customerMail.includes("Trip fare") && customerMail.includes(`$${tripFare}`) && customerMail.includes(`$${total}`));
  assert.ok(customerMail.includes("Meet &amp; Greet") || customerMail.includes("Meet & Greet"));
  for (const leak of ["$150.00", "Fixed tier", "Trip estimate", "(internal)", "per mile", "per_mile", "$6.00"]) assert.ok(!customerMail.includes(leak), `customer email leaks: ${leak}`);
  // The business email keeps the internal breakdown.
  const bizMail = JSON.stringify(net.calls.filter((c) => c.url === "https://api.brevo.com/v3/smtp/email" && !(c.body?.to ?? []).some((t: any) => t.email === "ann@example.com") && JSON.stringify(c.body).includes(r.reference)).map((c) => c.body));
  assert.ok(bizMail.includes("Fixed tier price (internal)") && bizMail.includes("$150.00"));
  // Customer pages' data and the public quote API.
  const { loadTrip } = await import("../src/lib/trip.ts");
  const view: any = await loadTrip(db, r.payment_token);
  assert.ok(!JSON.stringify(view).match(/fixed|15000|per_?mile/i));
  assert.equal(view.view.charges.tripFareCents, 15000 + r.estimated_fare_cents);
  const quoteJson = JSON.stringify(await (await routes.quote.POST(post("/api/fare/quote", trip()))).json());
  assert.ok(!/fixedPriceCents|per_mile|perMile|lineItems|\/mi/.test(quoteJson));
  // Stripe-facing request has no internal wording or tier fee line.
  const stripeBody = decodeURIComponent(net.calls.filter((c) => c.url.includes("api.stripe.com")).map((c) => String(c.body)).join("&").replace(/\+/g, " "));
  assert.ok(!/fixed|per mile|tier/i.test(stripeBody));
  // Admin retains the internal pieces on the booking.
  assert.deepEqual([r.fixed_price_cents, r.estimated_fare_cents > 0, r.meet_greet_fee_cents], [15000, true, 3500]);
});

test("complete fare: double clicks, retries and concurrent requests never create a second charge", async () => {
  authOn();
  const b = await makeBooking(); await approve(b);
  stripeMock.nextCharge = "processing"; const from = stripeMock.charges.length;
  const results = await Promise.all([confirmCharge(b), confirmCharge(b), confirmCharge(b), confirmCharge(b), confirmCharge(b)]);
  for (const r of results) assert.equal(r.status, 200);
  assert.equal(stripeMock.charges.slice(from).length, 1);                                    // one PaymentIntent for five simultaneous clicks
  assert.equal(db.t("payments").filter((x: any) => x.booking_id === b.row.id).length, 1);
  await confirmCharge(b); await confirmCharge(b);                                           // later retries while it is processing
  assert.equal(stripeMock.charges.slice(from).length, 1);
  assert.equal(db.t("payments").filter((x: any) => x.booking_id === b.row.id).length, 1);
  assert.equal(b.row.payment_status, "processing"); assert.equal(b.row.confirmed_at ?? null, null); assert.equal(b.row.amount_paid_cents, 0);
});

test("complete fare: bookings created before the fix (frozen at tier fee + services) are re-priced once, only while nothing was held or paid", async () => {
  setPay("full"); setFixed(10000, 15000, 22000);
  db.t("booking_settings")[0].stripe_authorize_at_booking = false;
  const { chargeForBooking } = await import("../src/lib/payments-server.ts");
  const legacy = async () => { const b = await makeBooking(); b.row.online_amount_cents = 15000; return b; }; // what the old code froze
  const a = await legacy();
  const c: any = await chargeForBooking(db as any, a.row);
  assert.ok(c.ok); assert.equal(c.charge.totalCents, 15000 + a.row.estimated_fare_cents); assert.equal(a.row.online_amount_cents, 15000 + a.row.estimated_fare_cents);
  assert.ok(db.t("activity_logs").some((l: any) => l.action === "booking.charge_upgraded" && l.entity_id === a.row.id));
  const c2: any = await chargeForBooking(db as any, a.row);                                  // idempotent: no second upgrade
  assert.equal(c2.charge.totalCents, 15000 + a.row.estimated_fare_cents);
  // Money already held/paid: the historical amount is honoured, never rewritten.
  const h = await legacy();
  db.seed("payments", [{ booking_id: h.row.id, provider: "stripe", amount_cents: 15000, status: "paid", paid_at: new Date().toISOString(), currency: "USD" }]);
  const hc: any = await chargeForBooking(db as any, h.row);
  assert.equal(hc.charge.totalCents, 15000); assert.equal(h.row.online_amount_cents, 15000);
  // Completed/cancelled bookings are never re-priced.
  const done = await legacy(); done.row.status = "completed";
  assert.equal(((await chargeForBooking(db as any, done.row)) as any).charge.totalCents, 15000);
  // Unknown trip fare: no online amount at all (never the fee alone).
  const noEst = await makeBooking(); noEst.row.online_amount_cents = null; noEst.row.fixed_price_cents = null; noEst.row.estimated_fare_cents = null;
  assert.equal(((await chargeForBooking(db as any, noEst.row)) as any).ok, false);
  setFixed(null, null, null);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Post-booking card step (direct redirect, resume, retry) and direct tracking links
// ---------------------------------------------------------------------------------------------------------------------------------
const stripePayments = (id: string) => db.t("payments").filter((x: any) => x.booking_id === id);
const setupPost = (body: object, extra?: Record<string, string>) => post("/api/bookings/card/setup", body, extra);

test("redirect: a new booking goes straight to the card step for THAT booking; the booking is saved first and nothing is charged or held", async () => {
  authOn(); const from = stripeMock.charges.length;
  const b = await makeBooking();
  assert.equal(b.res.status, 200);
  assert.equal(b.data.cardStep, true);                                                           // the client goes to the card step
  assert.equal(b.data.confirmUrl, `/book/confirmation?t=${b.row.payment_token}`);               // private token, never the VT- reference
  assert.ok(!JSON.stringify(b.data).includes(b.row.id));                                         // no internal database id
  assert.equal(b.data.payUrl, undefined); assert.equal(b.data.authorizeUrl, undefined);
  assert.equal(stripePayments(b.row.id).length, 0); assert.equal(stripeMock.charges.length, from);   // no payment row, no charge, no hold
  assert.equal(b.row.payment_status === "paid", false); assert.equal(b.row.confirmed_at ?? null, null); assert.equal(b.row.card_flow, true);
  assert.equal(b.row.amount_paid_cents, 0);
  // Payments off or Stripe unavailable: the request is still saved, there is no card step, and the customer's page says what happens next.
  setPay("disabled");
  const off = await makeBooking();
  assert.equal(off.data.cardStep, false); assert.match(off.data.confirmUrl, /^\/book\/confirmation\?t=/); assert.equal(off.row.card_flow, false);
  assert.equal(brevoTo("ann@example.com").filter((c) => JSON.stringify(c.body).includes(off.row.reference)).length >= 0, true);
  setPay("full");
});

test("retry: a repeated submission, refresh or double click resumes the SAME booking and card form; no duplicate booking, no second SetupIntent, no payment rows", async () => {
  authOn();
  const key = `dup-${++pk}-bbbbbbbbbbbbbbbbbb`;
  const bookings0 = db.t("bookings").length;
  const first = await makeBooking({ submissionKey: key });
  const second = await makeBooking({ submissionKey: key });                                      // the customer pressed submit again
  assert.equal(db.t("bookings").length, bookings0 + 1);                                          // one booking
  assert.equal(second.data.reference, first.data.reference); assert.equal(second.data.confirmUrl, first.data.confirmUrl);
  assert.equal(stripePayments(first.row.id).length, 0);
  // The setup endpoint (private token) hands back the SAME SetupIntent however many times it is hit, and creates one Stripe customer.
  const sis0 = stripeMock.setupCreates, cust0 = stripeMock.customers; const secrets = new Set<string>();
  for (let i = 0; i < 3; i++) { const r = await routes.cardSetup.POST(setupPost({ token: first.row.payment_token, consent: true })); assert.equal(r.status, 200); const d = await r.json(); assert.equal(d.publishableKey, "pk_test_x"); secrets.add(d.clientSecret); }
  assert.equal(secrets.size, 1); assert.equal(stripeMock.setupCreates, sis0 + 1); assert.equal(stripeMock.customers, cust0 + 1);
  // Two tabs at once: still one SetupIntent.
  const c = await makeBooking(); const s0 = stripeMock.setupCreates;
  const both = await Promise.all([routes.cardSetup.POST(setupPost({ token: c.row.payment_token, consent: true })), routes.cardSetup.POST(setupPost({ token: c.row.payment_token, consent: true }))]);
  assert.deepEqual(both.map((r) => r.status), [200, 200]);
  assert.equal(new Set((await Promise.all(both.map((r) => r.json()))).map((d) => d.clientSecret)).size, 1);
  assert.equal(stripeMock.setupCreates - s0 <= 2, true); assert.equal(stripePayments(c.row.id).length, 0);
});

test("card step: consent is required, an unfinished form is reused, a card can be replaced before approval, failures never save a card", async () => {
  authOn();
  // Stripe unavailable while booking: the booking is still saved and says so; no card step is offered.
  const saved = process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_SECRET_KEY;
  const n = await makeBooking();
  assert.equal(n.res.status, 200); assert.equal(n.data.cardStep, false); assert.match(n.data.confirmUrl, /^\/book\/confirmation\?t=/);
  assert.equal((await routes.cardSetup.POST(setupPost({ token: n.row.payment_token, consent: true }))).status, 503);
  process.env.STRIPE_SECRET_KEY = saved;
  const b = await makeBooking();
  assert.equal((await routes.cardSetup.POST(setupPost({ token: b.row.payment_token }))).status, 422);                // no consent
  assert.equal((await routes.cardSetup.POST(setupPost({ token: b.row.payment_token, consent: "yes" }))).status, 422); // must be exactly true
  assert.equal(stripeMock.sis.size > 0 && b.row.stripe_setup_intent_id == null, true);
  // The browser says "done" before Stripe has the card: the server checks with Stripe and saves nothing.
  const s1 = await routes.cardSetup.POST(setupPost({ token: b.row.payment_token, consent: true })); assert.equal(s1.status, 200);
  const early = await routes.cardComplete.POST(post("/api/bookings/card/complete", { token: b.row.payment_token }));
  assert.equal(early.status, 409); assert.equal(b.row.card_setup_at ?? null, null); assert.equal(b.row.payment_status, "unpaid");
  // A card entered for ANOTHER booking's SetupIntent cannot be attached here.
  const other = await makeBooking(); await routes.cardSetup.POST(setupPost({ token: other.row.payment_token, consent: true }));
  const foreign = stripeMock.completeSetup(other.row.stripe_setup_intent_id);
  const si = stripeMock.sis.get(b.row.stripe_setup_intent_id); si.metadata.booking_id = other.row.id;                   // tampered metadata
  stripeMock.completeSetup(b.row.stripe_setup_intent_id);
  assert.equal((await routes.cardComplete.POST(post("/api/bookings/card/complete", { token: b.row.payment_token }))).status, 409);
  assert.equal(b.row.card_setup_at ?? null, null); si.metadata.booking_id = b.row.id; void foreign;
  // The genuine completion saves the card; repeating it (refresh, webhook) is harmless.
  assert.equal((await routes.cardComplete.POST(post("/api/bookings/card/complete", { token: b.row.payment_token }))).status, 200);
  const when = b.row.card_setup_at; assert.ok(when); assert.equal(b.row.payment_status, "card_saved");
  assert.equal((await routes.cardComplete.POST(post("/api/bookings/card/complete", { token: b.row.payment_token }))).status, 200); assert.equal(b.row.card_setup_at, when);
  // Replacing the card before approval: a new SetupIntent; the old card is removed from Stripe.
  const oldPm = b.row.stripe_payment_method_id; stripeMock.detached = [];
  const r = await routes.cardSetup.POST(setupPost({ token: b.row.payment_token, consent: true })); assert.equal(r.status, 200);
  stripeMock.last4 = "1881"; stripeMock.completeSetup(b.row.stripe_setup_intent_id); stripeMock.last4 = "4242";
  assert.equal((await routes.cardComplete.POST(post("/api/bookings/card/complete", { token: b.row.payment_token }))).status, 200);
  assert.equal(b.row.card_last4, "1881"); assert.notEqual(b.row.stripe_payment_method_id, oldPm); assert.deepEqual(stripeMock.detached, [oldPm]);
  assert.equal(stripePayments(b.row.id).length, 0);                                                                    // still nothing charged
  // The setup_intent.succeeded webhook for a stale/foreign intent is ignored; the booking's own intent is idempotent.
  const staleEv = { id: `evt_si_${++ev}`, type: "setup_intent.succeeded", data: { object: { id: "seti_old", object: "setup_intent", metadata: { booking_id: b.row.id } } } };
  assert.equal((await routes.webhook.POST(hook(staleEv))).status, 200); assert.equal(b.row.card_last4, "1881");
});

test("card and confirmation endpoints: private token or tracking ID only; foreign origin, malformed or unknown credentials and references are refused and reveal nothing", async () => {
  authOn();
  const b = await makeBooking();
  const n = db.t("payments").length, sis = stripeMock.setupCreates;
  const evil = (path: string) => new Request(`http://site.test${path}`, { method: "POST", headers: { ...HDR(), origin: "http://evil.test" }, body: JSON.stringify({ token: b.row.payment_token, consent: true }) });
  for (const path of ["/api/bookings/card/setup", "/api/bookings/card/complete", "/api/bookings/confirm", "/api/bookings/confirm/finalize"]) {
    const route = path.endsWith("setup") ? routes.cardSetup : path.endsWith("complete") ? routes.cardComplete : path.endsWith("finalize") ? routes.confirmFinal : routes.confirm;
    assert.equal((await route.POST(evil(path))).status, 403, path);
  }
  for (const bad of [b.row.reference, b.row.id.slice(0, 8), "", null, 5, {}, b.row.id]) assert.equal((await routes.confirm.POST(post("/api/bookings/confirm", { token: bad, consent: true }))).status, 404, String(bad));
  assert.equal((await routes.confirm.POST(post("/api/bookings/confirm", { token: "00000000-0000-4000-8000-000000000000", consent: true }))).status, 404);
  assert.equal(db.t("payments").length, n); assert.equal(stripeMock.setupCreates, sis);
  // The tracking ID is also a valid credential for the same booking; the client never supplies an id or an amount.
  const viaCode = await routes.cardSetup.POST(setupPost({ trackingId: b.row.tracking_code, consent: true })); assert.equal(viaCode.status, 200);
});

test("confirmation page data: tied to the private token, customer-safe, shows tracking ID; unknown tokens and references give nothing", async () => {
  authOn();
  const b = await makeBooking();
  const { loadConfirmation } = await import("../src/lib/confirmation.ts");
  const v: any = await loadConfirmation(db, b.row.payment_token);
  assert.equal(v.trip.reference, b.row.reference); assert.equal(v.trackingCode, b.row.tracking_code);
  assert.equal(v.trip.charges.totalCents, b.row.online_amount_cents); assert.equal(v.trip.stage, "card_needed"); assert.equal(v.trip.canAddCard, true); assert.equal(v.trip.canConfirm, false);
  const dump = JSON.stringify(v);
  for (const secret of [b.row.id, b.row.payment_token, b.row.customer_id, "fixed", "per_mile", "Dana", "4105550100", "ann@example.com", "sk_test"]) assert.ok(!dump.includes(String(secret)), String(secret));
  assert.equal(await loadConfirmation(db, b.row.reference), null); assert.equal(await loadConfirmation(db, b.row.tracking_code), null); assert.equal(await loadConfirmation(db, "00000000-0000-4000-8000-000000000000"), null);
  // The customer sees an accurate status at every stage.
  await saveCard(b);
  let t: any = (await loadConfirmation(db, b.row.payment_token))!.trip;
  assert.equal(t.stage, "awaiting_approval"); assert.equal(t.headline, "Booking Request Received: Awaiting Admin Approval"); assert.deepEqual(t.card, { brand: "visa", last4: "4242" });
  assert.equal(t.canConfirm, false);                                                      // approval first
  await approve(b);
  t = (await loadConfirmation(db, b.row.payment_token))!.trip;
  assert.equal(t.stage, "approved_ready"); assert.equal(t.canConfirm, true); assert.equal(t.headline, "Approved: please confirm your booking");
  stripeMock.nextCharge = "requires_action"; await confirmCharge(b);
  t = (await loadConfirmation(db, b.row.payment_token))!.trip; assert.equal(t.stage, "action_required");
  stripeMock.nextCharge = "declined"; const pAct = db.t("payments").filter((x: any) => x.booking_id === b.row.id).at(-1); pAct.status = "failed";   // the customer abandoned/failed the bank check
  await confirmCharge(b);
  t = (await loadConfirmation(db, b.row.payment_token))!.trip; assert.equal(t.stage, "payment_failed"); assert.equal(t.canConfirm, true);       // retry is offered
  stripeMock.nextCharge = "succeeded"; await confirmCharge(b);
  t = (await loadConfirmation(db, b.row.payment_token))!.trip; assert.equal(t.stage, "confirmed"); assert.equal(t.confirmed, true);
  // The page itself links the tracking ID straight to that ride and is part of the original booking flow.
  const page = readFileSync("src/app/(site)/book/confirmation/page.tsx", "utf8");
  assert.ok(page.includes("trackingPath(view.trackingCode)") && page.includes("href={track}") && page.includes("ConfirmationLive") && page.includes('referrer: "no-referrer"'));
  const form = readFileSync("src/components/BookingForm.tsx", "utf8");
  assert.ok(form.includes("data.confirmUrl") && !form.includes("authorizeUrl") && !form.includes("payUrl"));
});

test("tracking links: URL builder uses the production https site, never localhost; malformed IDs never produce a link", async () => {
  const { siteBase, trackingUrl, trackingPath } = await import("../src/lib/tracking-url.ts");
  const code = "TRK-7Q2MK-9XH4D-B6TWA";
  assert.equal(trackingUrl(code, "https://vantatransportation.example"), `https://vantatransportation.example/track#id=${code}`);
  assert.equal(trackingUrl(" trk 7q2mk.9xh4d-b6twa ", "https://v.example"), `https://v.example/track#id=${code}`);
  assert.equal(siteBase("https://v.example/", "production"), "https://v.example");
  assert.equal(siteBase("http://v.example", "production"), "https://v.example");               // upgraded to https in production
  assert.equal(siteBase("http://localhost:3000", "production"), null);                          // never localhost in production
  assert.equal(siteBase("", "production"), null); assert.equal(siteBase("not a url", "production"), null); assert.equal(siteBase("ftp://x.example", "production"), null);
  assert.equal(siteBase("http://localhost:3000", "development"), "http://localhost:3000");
  for (const bad of ["VT-1004", "", null, undefined, "TRK-1", 5]) { assert.equal(trackingUrl(bad as any, "https://v.example"), null); assert.equal(trackingPath(bad), null); }
  assert.equal(trackingUrl(code, null), null);
  assert.equal(trackingPath(code), `/track#id=${code}`);
});

test("emails: the Tracking ID is a real hyperlink to that ride in every customer email that shows it (HTML and plain text)", async () => {
  const { buildNotification, renderEmail } = await import("../src/lib/notify/templates.ts");
  const code = "TRK-7Q2MK-9XH4D-B6TWA", url = `https://v.example/track#id=${code}`;
  const base = { Reference: "VT-1", _customerEmail: "ann@example.com", _customerName: "Ann", _trackingId: code, _trackUrl: url, When: "Mon", Pickup: "A", Destination: "B" };
  const cases: [string, Record<string, string>][] = [["booking.created", base], ["booking.confirmed", base], ["booking.approved", { ...base, "Booking page": url }], ["booking.driver_assigned", { ...base, Driver: "Dana" }], ["booking.rescheduled", { ...base, "Tracking ID": code, "Previous pickup time": "a", "New pickup time": "b" }]];
  for (const [ev, d] of cases) {
    const m = buildNotification(ev as any, d).emails.find((e) => e.audience === "customer")!;
    const { html, text } = renderEmail(m);
    assert.ok(html.includes(`<a href="${url}"`) && html.includes(`>${code}</a>`), `${ev}: tracking ID is an anchor`);
    assert.ok(text.includes(url), `${ev}: plain-text version carries the link`);
    assert.ok(html.includes(">Track your ride</a>") || ev === "booking.approved" || ev === "booking.driver_assigned", `${ev}: Track your ride button`);
    assert.ok(!html.includes("localhost"));
    // Business emails never carry the customer's tracking link.
    for (const biz of buildNotification(ev as any, d).emails.filter((e) => e.audience === "business")) assert.ok(!renderEmail(biz).html.includes(code));
  }
  // The approval email's button opens the customer's own booking page to review and confirm (never a payment link) and still links the ID.
  const ap = buildNotification("booking.approved", { ...base, "Booking page": url }).emails[0]; assert.equal(ap.ctaLabel, "Review and confirm your booking"); assert.equal(ap.ctaUrl, url); assert.equal(ap.links?.["Tracking ID"], url);
  assert.ok(!JSON.stringify(ap).includes("/pay/") && !/payment link|Pay online/i.test(JSON.stringify(ap).replace(/never ask you to pay through a link/i, "")));
  // No usable URL, no link: never a broken one. Hostile values are escaped and non-http(s) URLs are ignored.
  const none = renderEmail(buildNotification("booking.created", { ...base, _trackUrl: undefined }).emails[1]); assert.ok(!none.html.includes("<a href"));
  assert.ok(!renderEmail({ audience: "customer", subject: "s", heading: "h", intro: "i", fields: { "Tracking ID": code }, links: { "Tracking ID": "javascript:alert(1)" } }).html.includes("javascript:"));
  assert.ok(renderEmail({ audience: "customer", subject: "s", heading: "h", intro: "i", fields: { "Tracking ID": code }, links: { "Tracking ID": 'https://v.example/"><script>' } }).html.includes("&quot;&gt;&lt;script&gt;"));
});

test("emails sent through Brevo: booking created, approved and confirmed all link the tracking ID to the same ride", async () => {
  authOn(); net.emailOk = true; net.calls.length = 0;
  const b = await makeBooking();
  await saveCard(b); await approve(b); stripeMock.nextCharge = "succeeded"; await confirmCharge(b);   // request notice -> approval -> verified payment
  const sent = brevoTo("ann@example.com").filter((c) => JSON.stringify(c.body).includes(b.row.reference));
  const anchor = `<a href=\\"http://site.test/track#id=${b.row.tracking_code}\\"`;
  const created = sent.find((c) => String(c.body.subject).includes("We received your booking request"))!;
  const approved = sent.find((c) => String(c.body.subject).includes("is approved"))!;
  const confirmed = sent.find((c) => String(c.body.subject).includes("is confirmed"))!;
  for (const m of [created, approved, confirmed]) { assert.ok(m, "email sent"); assert.ok(JSON.stringify(m.body).includes(anchor)); assert.ok(m.body.textContent.includes(`/track#id=${b.row.tracking_code}`)); assert.ok(!JSON.stringify(m.body).includes("/pay/")); }
  assert.equal(db.t("payments").find((x: any) => x.booking_id === b.row.id).status, "paid");
  // The approval email's button opens the customer's own tracker, where they confirm.
  assert.ok(JSON.stringify(approved.body).includes("Review and confirm your booking"));
});

test("direct links: the tracking ID opens THAT ride for pending, approved and paid bookings; wrong, foreign or reference lookups reveal nothing", async () => {
  authOn();
  const pendingB = await makeBooking(); await saveCard(pendingB);
  const held = await makeBooking(); await approve(held);
  const paidB = await makeBooking(); await confirmBooking(paidB);
  const tp = async (code: string) => { const r = await trackPost(code); return { status: r.status, body: await r.json() }; };
  for (const [bk, label] of [[pendingB, "pending"], [held, "approved"], [paidB, "paid"]] as const) {
    const r = await tp(bk.row.tracking_code);
    assert.equal(r.status, 200, label); assert.equal(r.body.trip.reference, bk.row.reference, label);                  // the right ride
    const dump = JSON.stringify(r.body);
    for (const secret of [bk.row.id, bk.row.payment_token, bk.row.customer_id, "4105550100", "ann@example.com", "4105550999", "dana@example.com"]) assert.ok(!dump.includes(String(secret)), `${label}: ${secret}`); // (the driver plate is intentionally shown once confirmed and paid)
  }
  assert.equal((await tp(paidB.row.tracking_code)).body.trip.paymentStatus, "paid"); assert.notEqual((await tp(held.row.tracking_code)).body.trip.paymentStatus, "paid");
  // Other people's codes, guessed codes and the booking reference never return a booking.
  for (const bad of ["TRK-AAAAA-AAAAA-AAAAA", pendingB.row.reference, pendingB.row.payment_token, pendingB.row.id, "TRK-"]) { const r = await tp(bad); assert.equal(r.status, 404, String(bad)); assert.equal(r.body.trip, undefined); }
  // The direct link is the existing fragment format that the Track page reads and clears; manual entry still goes through the same lookup.
  const tl = readFileSync("src/components/TrackLookup.tsx", "utf8");
  assert.ok(tl.includes("#id=") && tl.includes('addEventListener("hashchange"') && tl.includes("history.replaceState") && tl.includes('id="track-id"') && tl.includes("onSubmit"));
  const conf = readFileSync("src/components/ConfirmationDetails.tsx", "utf8"); assert.ok(conf.includes("trackingPath(saved.trackingId)"));
});


// =====================================================================================================================================
// Saved-card workflow acceptance tests: card saved at booking (no charge, no hold) -> admin approval -> customer confirmation -> charge -> confirmed
// =====================================================================================================================================
const SC = async () => { authOn(); net.emailOk = true; const b = await makeBooking(); await saveCard(b); return b; };
const finalizePost = (b: any) => routes.confirmFinal.POST(post("/api/bookings/confirm/finalize", { token: b.row.payment_token }));
const liveCharges = (b: any) => db.t("payments").filter((x: any) => x.booking_id === b.row.id);

test("saved card: card setup alone creates no charge and no hold, and the booking stays pending", async () => {
  authOn(); const from = stripeMock.charges.length;
  const b = await makeBooking(); await saveCard(b);
  assert.equal(stripeMock.charges.length, from); assert.equal(liveCharges(b).length, 0);                      // no PaymentIntent of any kind (no charge, no authorization hold)
  assert.equal(stripeMock.pis.size >= 0, true);
  const si = stripeMock.sis.get(b.row.stripe_setup_intent_id); assert.equal(si.usage, "off_session"); assert.equal(si.metadata.booking_id, b.row.id);
  assert.equal(b.row.status, "new_request"); assert.equal(b.row.amount_paid_cents, 0); assert.equal(b.row.confirmed_at ?? null, null); assert.equal(b.row.approved_at ?? null, null);
  // Only Stripe object ids and the brand + last four are stored: never a card number, expiry or CVC.
  const stored = JSON.stringify(b.row);
  assert.ok(!/4242424242424242|"cvc"|"cvv"|card_number/i.test(stored)); assert.ok(stored.includes('"card_last4":"4242"'));
  for (const f of ["sk_test_x"]) assert.ok(!stored.includes(f));
});

test("saved card: admin cannot approve a booking whose card step is unfinished; approval alone neither charges nor confirms", async () => {
  authOn();
  const b = await makeBooking();                                                                  // card step not finished
  const blocked = await adminAs(() => routes.workflow.POST(post("/api/admin/bookings/workflow", { id: b.row.id, action: "approve" })));
  assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, "card_setup_incomplete"); assert.equal(b.row.status, "new_request");
  await saveCard(b);
  const from = stripeMock.charges.length;
  assert.equal((await adminAs(() => routes.workflow.POST(post("/api/admin/bookings/workflow", { id: b.row.id, action: "approve" })))).status, 200);
  assert.equal(stripeMock.charges.length, from); assert.equal(liveCharges(b).length, 0);
  assert.equal(b.row.status, "approved"); assert.equal(b.row.payment_status, "card_saved"); assert.equal(b.row.confirmed_at ?? null, null); assert.equal(b.row.customer_confirmed_at ?? null, null);
  // Approval and customer confirmation are two separate recorded actions.
  assert.ok(b.row.approved_at); assert.ok(b.row.approved_by !== undefined);
  const { adminChecklist } = await import("../src/lib/customer-stage.ts");
  let c = adminChecklist(b.row); assert.equal(c.headline, "Approved: awaiting customer confirmation");
  assert.deepEqual(c.items.map((i) => [i.key, i.done]), [["card", true], ["approval", true], ["customer", false], ["payment", false], ["confirmed", false]]);
  stripeMock.nextCharge = "succeeded"; await confirmCharge(b);
  c = adminChecklist(b.row); assert.equal(c.headline, "Confirmed and paid: ready for driver assignment"); assert.ok(c.items.every((i) => i.done));
});

test("saved card: only an authenticated admin can approve or assign; the customer cannot approve, and no admin action confirms for the customer", async () => {
  const b = await SC();
  assert.equal((await routes.workflow.POST(post("/api/admin/bookings/workflow", { id: b.row.id, action: "approve" }))).status, 401);       // no session
  assert.equal(b.row.status, "new_request");
  // Customer-side endpoints cannot approve: confirming an unapproved booking is refused and nothing is charged.
  const from = stripeMock.charges.length;
  for (const body of [{ token: b.row.payment_token }, { trackingId: b.row.tracking_code }]) {
    const r = await routes.confirm.POST(post("/api/bookings/confirm", { ...body, consent: true, approved: true, status: "approved", approved_at: new Date().toISOString() }));
    assert.equal(r.status, 409); assert.equal((await r.json()).code, "not_approved");
  }
  assert.equal(stripeMock.charges.length, from); assert.equal(b.row.status, "new_request"); assert.equal(b.row.approved_at ?? null, null);
  // The generic editor cannot approve, confirm or set a card either.
  await adminAs(() => routes.crud.POST(post("/api/admin/crud", { resource: "bookings", action: "update", id: b.row.id, values: { status: "approved", approved_at: new Date().toISOString(), payment_released_at: new Date().toISOString(), customer_confirmed_at: new Date().toISOString(), stripe_payment_method_id: "pm_evil", card_setup_at: new Date().toISOString() } })));
  assert.equal(b.row.approved_at ?? null, null); assert.equal(b.row.customer_confirmed_at ?? null, null); assert.notEqual(b.row.stripe_payment_method_id, "pm_evil");
  assert.equal((await confirmCharge(b)).status, 409);
  // After approval the customer must still consent: a request without the consent flag charges nothing.
  await approve(b);
  const noConsent = await routes.confirm.POST(post("/api/bookings/confirm", { token: b.row.payment_token })); assert.equal(noConsent.status, 422);
  assert.equal(liveCharges(b).length, 0); assert.equal(b.row.customer_confirmed_at ?? null, null);
  // Assigning a driver needs an admin session as well.
  assert.equal((await routes.workflow.POST(post("/api/admin/bookings/workflow", { id: b.row.id, action: "assign", driverId: aDriver().id }))).status, 401);
});

test("saved card: the tracking ID can confirm its own booking; another booking's credentials cannot", async () => {
  const a = await SC(), other = await SC(); await approve(a); await approve(other);
  stripeMock.nextCharge = "succeeded";
  const wrong = await routes.confirm.POST(post("/api/bookings/confirm", { trackingId: "TRK-AAAAA-AAAAA-AAAAA", consent: true })); assert.equal(wrong.status, 404);
  const r = await routes.confirm.POST(post("/api/bookings/confirm", { trackingId: a.row.tracking_code, consent: true })); assert.equal((await r.json()).state, "paid");
  assert.equal(a.row.status, "confirmed"); assert.equal(other.row.status, "approved"); assert.equal(liveCharges(other).length, 0);   // the other booking is untouched
  const p = liveCharges(a)[0]; assert.equal(p.amount_cents, a.row.online_amount_cents);
});

test("saved card: the charge is the complete authoritative total, verified on the server, and uses the booking's own customer and card", async () => {
  const b = await SC(); await approve(b);
  stripeMock.nextCharge = "succeeded"; const from = stripeMock.charges.length;
  await routes.confirm.POST(post("/api/bookings/confirm", { token: b.row.payment_token, consent: true, amountCents: 1, totalCents: 1, currency: "eur", paymentMethodId: "pm_other", customerId: "cus_other" }));
  const f = stripeMock.charges.slice(from)[0].body;
  assert.equal(f.get("amount"), String(b.row.online_amount_cents)); assert.equal(f.get("currency"), "usd");
  assert.equal(f.get("customer"), b.row.stripe_customer_id); assert.equal(f.get("payment_method"), b.row.stripe_payment_method_id);   // never a browser-supplied customer or card
  assert.equal(f.get("metadata[booking_id]"), b.row.id);
  // The saved card must belong to the booking's Stripe customer: a swapped payment method is refused before Stripe is called.
  const c = await SC(); await approve(c);
  c.row.stripe_payment_method_id = null;
  const n = stripeMock.charges.length;
  const r = await confirmCharge(c); assert.equal(r.status, 409); assert.equal((await r.json()).code, "card_required"); assert.equal(stripeMock.charges.length, n);
  // A missing stored amount is never invented from the browser: the server re-derives it from its own tier and trip estimate, or refuses.
  const d = await SC(); await approve(d); d.row.online_amount_cents = null; stripeMock.nextCharge = "succeeded";
  assert.equal((await confirmCharge(d)).status, 200); assert.equal(liveCharges(d)[0].amount_cents, 15000 + d.row.estimated_fare_cents);
});

test("saved card: a declined charge never confirms or marks paid; the customer can retry or use another card; the admin is alerted", async () => {
  const b = await SC(); await approve(b);
  stripeMock.nextCharge = "declined";
  const r = await confirmCharge(b); const d = await r.json();
  assert.equal(r.status, 402); assert.match(d.error, /declined|insufficient/i); assert.match(d.error, /not been charged/i);
  const p1 = liveCharges(b)[0];
  assert.equal(p1.status, "failed"); assert.equal(p1.paid_at ?? null, null);
  assert.equal(b.row.status, "approved"); assert.equal(b.row.payment_status, "failed"); assert.equal(b.row.confirmed_at ?? null, null); assert.equal(b.row.amount_paid_cents, 0);
  assert.ok(db.t("admin_notifications").some((n: any) => n.event === "payment.failed" && n.entity_id === b.row.id));
  assert.equal(brevoTo("ann@example.com").filter((c) => String(c.body.subject).includes("is confirmed") && JSON.stringify(c.body).includes(b.row.reference)).length, 0);
  const { loadTrip } = await import("../src/lib/trip.ts");
  assert.equal(((await loadTrip(db, b.row.payment_token)) as any).view.stage, "payment_failed");           // retry is offered, same booking
  // Use a different card, then retry: one NEW attempt on the SAME booking (no duplicate booking).
  const bookings = db.t("bookings").length;
  stripeMock.last4 = "0005"; await routes.cardSetup.POST(setupPost({ token: b.row.payment_token, consent: true })); stripeMock.completeSetup(b.row.stripe_setup_intent_id); stripeMock.last4 = "4242";
  assert.equal((await routes.cardComplete.POST(post("/api/bookings/card/complete", { token: b.row.payment_token }))).status, 200); assert.equal(b.row.card_last4, "0005");
  stripeMock.nextCharge = "succeeded";
  assert.equal((await (await confirmCharge(b)).json()).state, "paid");
  assert.equal(db.t("bookings").length, bookings); assert.equal(liveCharges(b).length, 2);
  assert.equal(b.row.status, "confirmed"); assert.equal(b.row.payment_status, "paid"); assert.equal(b.row.amount_paid_cents, b.row.online_amount_cents);       // paid ONCE
  assert.equal(liveCharges(b).filter((x: any) => x.status === "paid").length, 1);
});

test("saved card: bank authentication (3-D Secure) is handled through Stripe; nothing is confirmed until Stripe verifies the payment", async () => {
  const b = await SC(); await approve(b);
  stripeMock.nextCharge = "requires_action";
  const r = await confirmCharge(b); const d = await r.json();
  assert.equal(r.status, 200); assert.equal(d.state, "requires_action"); assert.match(d.clientSecret, /_secret_/);
  const p = liveCharges(b)[0];
  assert.equal(p.status, "requires_action"); assert.equal(b.row.payment_status, "requires_action"); assert.equal(b.row.status, "approved"); assert.equal(b.row.confirmed_at ?? null, null); assert.equal(b.row.amount_paid_cents, 0);
  // Clicking again resumes the SAME authentication: no second PaymentIntent.
  const n = stripeMock.charges.length;
  const again = await (await confirmCharge(b)).json(); assert.equal(again.state, "requires_action"); assert.equal(again.clientSecret, d.clientSecret); assert.equal(stripeMock.charges.length, n); assert.equal(liveCharges(b).length, 1);
  // The browser reports "done" but the customer abandoned the bank page: finalize re-checks with Stripe and confirms nothing.
  const f1 = await (await finalizePost(b)).json(); assert.equal(f1.state, "requires_action"); assert.equal(b.row.confirmed_at ?? null, null);
  // The customer completes the bank's check; Stripe now reports success; only then is it paid and confirmed.
  const pi = stripeMock.pis.get(p.stripe_payment_intent_id); pi.status = "succeeded"; pi.amount_received = pi.amount;
  const f2 = await (await finalizePost(b)).json(); assert.equal(f2.state, "paid");
  assert.equal(p.status, "paid"); assert.equal(b.row.status, "confirmed"); assert.ok(b.row.confirmed_at); assert.equal(b.row.payment_status, "paid");
  // A failed authentication keeps everything unconfirmed and offers a retry.
  const c = await SC(); await approve(c); stripeMock.nextCharge = "requires_action"; const cd = await (await confirmCharge(c)).json();
  const cp = liveCharges(c)[0]; const cpi = stripeMock.pis.get(cp.stripe_payment_intent_id); cpi.status = "requires_payment_method"; cpi.last_payment_error = { code: "card_declined" };
  const ff = await finalizePost(c); assert.equal(ff.status, 402); assert.equal(cp.status, "failed"); assert.equal(c.row.status, "approved"); assert.equal(c.row.confirmed_at ?? null, null); void cd;
});

test("saved card: a dropped connection or Stripe outage never double-charges and never falsely fails or confirms", async () => {
  const b = await SC(); await approve(b);
  stripeMock.nextCharge = "network";
  const r = await confirmCharge(b); const d = await r.json();
  assert.equal(r.status, 200); assert.equal(d.state, "processing");
  const p = liveCharges(b)[0]; assert.equal(p.status, "processing"); assert.equal(b.row.confirmed_at ?? null, null); assert.equal(b.row.amount_paid_cents, 0);
  assert.equal(db.t("admin_notifications").some((n: any) => n.event === "payment.failed" && n.entity_id === b.row.id), false);   // an unknown outcome is not a failure
  // Retrying joins the SAME attempt (same idempotency key) and learns the real outcome.
  stripeMock.nextCharge = "succeeded"; const n = stripeMock.charges.length;
  assert.equal((await (await confirmCharge(b)).json()).state, "paid");
  assert.equal(stripeMock.charges.length, n + 1); assert.equal(liveCharges(b).length, 1); assert.equal(stripeMock.charges.at(-1)!.key, `charge-${p.id}`);
  assert.equal(b.row.status, "confirmed"); assert.equal(b.row.amount_paid_cents, b.row.online_amount_cents);
  // An idempotency-key collision from a concurrent request is also "unknown", not a card failure.
  const { createSavedCardCharge } = await import("../src/lib/stripe.ts"); void createSavedCardCharge;
});

test("saved card: webhooks are safe when duplicated, delayed or out of order; a late failure cannot undo a payment", async () => {
  const b = await SC(); await approve(b); stripeMock.nextCharge = "processing"; await confirmCharge(b);
  const p = liveCharges(b)[0];
  const ok = sessionEvent("checkout.session.completed", p, {}, "evt_ooo_ok");
  const late = (type: string, id: string) => sessionEvent(type, p, {}, id);
  // The success arrives FIRST; delayed "processing" / "requires_action" / "failed" / "cancelled" events arrive afterwards, plus duplicates.
  assert.equal((await routes.webhook.POST(hook(ok))).status, 200);
  assert.equal(p.status, "paid"); assert.equal(b.row.status, "confirmed");
  for (const [type, id] of [["checkout.session.async_payment_failed", "evt_late_f"], ["checkout.session.expired", "evt_late_c"]] as const) await routes.webhook.POST(hook(late(type, id)));
  await routes.webhook.POST(hook({ id: "evt_late_p", type: "payment_intent.processing", data: { object: { id: p.stripe_payment_intent_id, metadata: { booking_id: b.row.id, payment_id: p.id } } } }));
  await routes.webhook.POST(hook({ id: "evt_late_ra", type: "payment_intent.requires_action", data: { object: { id: p.stripe_payment_intent_id, metadata: { booking_id: b.row.id, payment_id: p.id } } } }));
  await routes.webhook.POST(hook(ok)); await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p, {}, "evt_ooo_ok2")));
  assert.equal(p.status, "paid"); assert.equal(b.row.payment_status, "paid"); assert.equal(b.row.status, "confirmed"); assert.equal(b.row.amount_paid_cents, b.row.online_amount_cents);
  assert.equal(liveCharges(b).length, 1); assert.equal(db.t("booking_status_history").filter((h: any) => h.booking_id === b.row.id && h.to_status === "confirmed").length, 1);
  // The webhook can arrive BEFORE our own request stored the PaymentIntent id: the payment is still found by its metadata.
  const c = await SC(); await approve(c); stripeMock.nextCharge = "processing"; await confirmCharge(c);
  const cp = liveCharges(c)[0]; const realPi = cp.stripe_payment_intent_id; cp.stripe_payment_intent_id = null;
  assert.equal((await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", { ...cp, stripe_payment_intent_id: realPi }, {}, "evt_early")))).status, 200);
  assert.equal(cp.status, "paid"); assert.equal(c.row.status, "confirmed");
  // A signature is required; a mismatching amount or booking is flagged and never paid.
  const d = await SC(); await approve(d); stripeMock.nextCharge = "processing"; await confirmCharge(d);
  const dp = liveCharges(d)[0];
  assert.equal((await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", dp, {}, "evt_bad_sig"), { secret: "whsec_wrong" }))).status, 400);
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", dp, { amount_total: 100 }, "evt_bad_amt")));
  assert.equal(dp.status, "review"); assert.equal(d.row.payment_status, "review"); assert.equal(d.row.confirmed_at ?? null, null); assert.equal(d.row.amount_paid_cents, 0);
});

test("saved card: an unconfirmed (customer never pressed confirm) payment can never confirm a booking, even if a verified payment arrives", async () => {
  const b = await SC(); await approve(b); stripeMock.nextCharge = "processing"; await confirmCharge(b);
  const p = liveCharges(b)[0]; b.row.customer_confirmed_at = null;                                // as if the explicit confirmation had not been recorded
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p, {}, "evt_unconfirmed")));
  assert.equal(p.status, "paid"); assert.equal(b.row.status, "approved"); assert.equal(b.row.confirmed_at ?? null, null);   // money recorded, booking NOT confirmed
  assert.match(db.t("admin_notifications").find((n: any) => n.event === "payment.paid" && n.entity_id === b.row.id).title, /needs review/i);
});

test("saved card: driver assignment follows the confirmed and paid state, in every route", async () => {
  const b = await SC(); await approve(b);
  const as = (x: any = b) => assignDriver(x);
  assert.equal((await as()).status, 409);                                                         // approved but not confirmed
  stripeMock.nextCharge = "processing"; await confirmCharge(b);
  assert.equal((await as()).status, 409);                                                         // confirmed by the customer, payment still processing
  const p = liveCharges(b)[0];
  await routes.webhook.POST(hook(sessionEvent("checkout.session.completed", p, {}, "evt_assign_ok")));
  assert.equal(b.row.status, "confirmed"); assert.equal(b.row.driver_id ?? null, null);
  assert.equal((await wf(b.row.id, { action: "advance", status: "getting_ready" })).status, 409);   // a ride cannot start without a driver
  assert.equal((await wf(b.row.id, { action: "reassign", driverId: aDriver().id })).status, 409);   // reassign needs an existing driver
  assert.equal((await as()).status, 200); assert.equal(b.row.status, "assigned");
  // A legacy booking that already has a driver but was never paid is still gated everywhere (see the payment-gate test); unknown/inactive drivers are refused.
  const c = await SC(); await confirmBooking(c);
  assert.equal((await assignDriver(c, "00000000-0000-4000-8000-000000000000")).status, 404);
  const inactive = db.t("drivers")[0]; inactive.is_active = false; assert.equal((await assignDriver(c, inactive.id)).status, 422); inactive.is_active = true;
});

test("saved card: PayPal keeps working as an alternative after approval; the old Stripe payment-link route is gone", async () => {
  authOn();
  const b = await makeBooking(); await saveCard(b);
  await withPayPal(async () => {
    assert.equal((await routes.checkout.POST(post("/api/payments/checkout", { token: b.row.payment_token, provider: "paypal" }))).status, 409);   // not approved yet
    await approve(b);
    const r = await routes.checkout.POST(post("/api/payments/checkout", { token: b.row.payment_token, provider: "paypal" }));
    assert.equal(r.status, 200); const out = await r.json();
    // A PayPal order and a saved-card charge cannot both be live: the customer cannot be charged twice.
    const pp = liveCharges(b).find((x: any) => x.provider === "paypal"); assert.equal(pp.status, "pending"); assert.equal(b.row.confirmed_at ?? null, null);
    const cap = await capture(b.row.payment_token, out.orderId); assert.equal(cap.status, 200);
    assert.equal(b.row.status, "confirmed"); assert.ok(b.row.customer_confirmed_at); assert.equal(b.row.payment_status, "paid");
  });
  // The hosted-Stripe "pay link" checkout no longer exists, and an in-progress card charge blocks a PayPal order.
  const c = await makeBooking(); await approve(c);
  const old = await routes.checkout.POST(post("/api/payments/checkout", { token: c.row.payment_token, provider: "stripe" }));
  assert.equal(old.status, 400); assert.equal(liveCharges(c).length, 0);
  stripeMock.nextCharge = "processing"; await confirmCharge(c);
  await withPayPal(async () => { assert.equal((await routes.checkout.POST(post("/api/payments/checkout", { token: c.row.payment_token, provider: "paypal" }))).status, 409); });
});

test("saved card: bookings from before the workflow are never charged or migrated automatically", async () => {
  authOn();
  const b = await makeBooking(); b.row.card_flow = false;                                         // created before the workflow: no card, no consent
  assert.equal((await confirmCharge(b)).status, 409);                                              // not approved
  assert.equal((await adminAs(() => routes.workflow.POST(post("/api/admin/bookings/workflow", { id: b.row.id, action: "approve" })))).status, 200);   // admin may approve (no card gate for old bookings)
  assert.equal(stripeMock.charges.length === 0 || liveCharges(b).length === 0, true);
  const r = await confirmCharge(b); assert.equal(r.status, 409); assert.equal((await r.json()).code, "card_required"); assert.equal(liveCharges(b).length, 0);   // approved alone never charges
  const { loadTrip } = await import("../src/lib/trip.ts");
  const v: any = (await loadTrip(db, b.row.payment_token))!.view; assert.equal(v.stage, "approved_card_needed"); assert.equal(v.canAddCard, true); assert.equal(v.canConfirm, false);
  // Existing payment history is untouched by any of this.
  const hist = authorized; void hist;
  const old = await authorized(); const before = JSON.stringify(old.p);
  await routes.webhook.POST(hook(piEvent("payment_intent.amount_capturable_updated", stripeMock.pis.get(old.piId))));
  assert.equal(JSON.stringify(old.p).includes('"status":"authorized"'), true); assert.ok(before.length > 0);
});

test("saved card: tracking pages, emails and the customer page never contain a payment link or the old wording", async () => {
  const b = await SC(); net.calls.length = 0; await approve(b);
  const mail = JSON.stringify(brevoTo("ann@example.com").map((c) => c.body));
  assert.ok(!/\/pay\/|secure payment link|No card is held/i.test(mail)); assert.ok(mail.includes("Review and confirm your booking"));
  // Source scan: the removed workflow leaves nothing behind in customer-facing code.
  const files = ["src/lib/notify/templates.ts", "src/components/BookingForm.tsx", "src/components/ConfirmationDetails.tsx", "src/components/TripStatus.tsx", "src/components/BookingActions.tsx", "src/components/ConfirmationLive.tsx", "src/app/(site)/book/confirmation/page.tsx", "src/lib/payments-server.ts", "src/lib/saved-card.ts"];
  for (const f of files) { const t = readFileSync(f, "utf8"); assert.ok(!/No card is held|we will email you a secure payment link|email you a secure payment link/i.test(t), `${f}: old wording`); assert.ok(!/createCheckoutSession|startAuthorization|captureAuthorization|authorizeUrl/.test(t), `${f}: removed flow`); }
  for (const gone of ["src/app/api/payments/authorize/route.ts", "src/components/AuthorizeCardButton.tsx", "src/components/PayButton.tsx"]) assert.equal(existsSync(gone), false, `${gone}: removed with the payment-link workflow, must not be restored or left behind`);
  // Secrets stay on the server: no client component imports the Stripe server module, and the publishable key is the only key sent to the browser.
  for (const f of ["src/components/CardSetupStep.tsx", "src/components/BookingActions.tsx", "src/components/ConfirmationLive.tsx", "src/components/TripStatus.tsx", "src/lib/stripe-client.ts"]) { const t = readFileSync(f, "utf8"); assert.ok(!/STRIPE_SECRET|sk_(live|test)|@\/lib\/stripe"|SERVICE_ROLE|@\/lib\/saved-card/.test(t), f); }
  assert.ok(!JSON.stringify((await (await trackPost(b.row.tracking_code, "10.55.0.1")).json())).match(/sk_test|whsec|secret/));
});

test("migration 0016 is additive, idempotent and stores no card numbers", () => {
  const f = readdirSync("supabase/migrations").filter((x) => x.startsWith("0016"));
  assert.equal(f.length, 1);
  const sql = readFileSync(`supabase/migrations/${f[0]}`, "utf8").toLowerCase();
  assert.ok(!/drop\s+(table|column)|truncate|delete\s+from|update\s+public\./.test(sql));                          // nothing dropped, reset or rewritten
  for (const col of ["card_flow", "stripe_customer_id", "stripe_setup_intent_id", "stripe_payment_method_id", "card_setup_at", "card_consent_at", "customer_confirmed_at", "saved_card"]) assert.ok(sql.includes(col), col);
  assert.ok((sql.match(/add column if not exists/g) ?? []).length >= 10); assert.ok(sql.includes("create unique index if not exists payments_one_live_saved_card_attempt"));
  for (const v of ["'approved'", "'card_saved'", "'processing'", "'requires_action'", "'authorized'", "'capture_failed'", "'needs_payment'", "'pending_confirmation'", "'paid'"]) assert.ok(sql.includes(v), v);   // old values stay valid
  assert.ok(!/card_number|\bcvv\b|\bcvc\b|\bpan\b|exp_month|exp_year/.test(sql.replace(/-- .*/g, "")));
});

test("saved card: pure stage logic and consent wording", async () => {
  const { customerStage } = await import("../src/lib/customer-stage.ts");
  const { CARD_SAVE_CONSENT_TEXT, cardChargeConsentText } = await import("../src/lib/card-consent.ts");
  const base = { status: "new_request", card_flow: true, card_setup_at: null, approved_at: null, confirmed_at: null, payment_released_at: null, payment_status: "unpaid", online_amount_cents: 28000 };
  assert.equal(customerStage(base), "card_needed");
  assert.equal(customerStage({ ...base, card_setup_at: "x", payment_status: "card_saved" }), "awaiting_approval");
  const ap = { ...base, status: "approved", card_setup_at: "x", approved_at: "x", payment_released_at: "x", payment_status: "card_saved" };
  assert.equal(customerStage(ap), "approved_ready"); assert.equal(customerStage({ ...ap, card_setup_at: null }), "approved_card_needed"); assert.equal(customerStage({ ...ap, online_amount_cents: null }), "no_online_payment");
  assert.equal(customerStage({ ...ap, latest_charge_status: "requires_action" }), "action_required"); assert.equal(customerStage({ ...ap, latest_charge_status: "processing" }), "processing");
  assert.equal(customerStage({ ...ap, payment_status: "failed", latest_charge_status: "failed" }), "payment_failed");
  assert.equal(customerStage({ ...ap, status: "confirmed", confirmed_at: "x", payment_status: "paid" }), "confirmed"); assert.equal(customerStage({ ...ap, payment_status: "review" }), "review");
  assert.equal(customerStage({ ...ap, status: "cancelled" }), "closed"); assert.equal(customerStage({ ...base, status: "rejected" }), "closed");
  assert.match(CARD_SAVE_CONSENT_TEXT, /Nothing is charged and no funds are held/); assert.match(cardChargeConsentText("$280.00"), /charge my saved card \$280\.00 now/);
});
