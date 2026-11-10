import { test } from "node:test";
import assert from "node:assert/strict";
import { zonedToUtc } from "../src/lib/geo/time.ts";
import { parseRoutesResponse } from "../src/lib/geo/parse.ts";
import { validateTrip } from "../src/lib/fare/trip.ts";
import { buildNotification, renderEmail } from "../src/lib/notify/templates.ts";
import { classifyPlace, classifyTrip, fulfilmentFor, looksLikeAirport } from "../src/lib/coverage.ts";
import { calculateRoundTrip, waitingCharge } from "../src/lib/pricing/roundtrip.ts";
import { validateBookingDetails } from "../src/lib/booking-details.ts";
import { waitingPolicyText } from "../src/lib/policies.ts";
import { coerceValues, slugify } from "../src/lib/admin/coerce.ts";
import { resources } from "../src/lib/admin/resources.ts";

test("zonedToUtc converts New York wall-clock time (EST and EDT)", () => {
  assert.equal(zonedToUtc("2026-01-15", "10:00", "America/New_York").toISOString(), "2026-01-15T15:00:00.000Z");
  assert.equal(zonedToUtc("2026-07-15", "10:00", "America/New_York").toISOString(), "2026-07-15T14:00:00.000Z");
});

test("parseRoutesResponse: no tolls, known tolls, unknown tolls, unusable", () => {
  const base = { distanceMeters: 16093, duration: "1800s", polyline: { encodedPolyline: "abc" } };
  const none = parseRoutesResponse({ routes: [base] });
  assert.equal(none?.distanceMiles, 10);
  assert.equal(none?.durationMinutes, 30);
  assert.equal(none?.toll.status, "none");

  const known = parseRoutesResponse({ routes: [{ ...base, travelAdvisory: { tollInfo: { estimatedPrice: [{ currencyCode: "USD", units: "4", nanos: 500000000 }] } } }] });
  assert.equal(known?.toll.status, "known");
  assert.equal(known?.toll.amount, 4.5);

  const unknown = parseRoutesResponse({ routes: [{ ...base, travelAdvisory: { tollInfo: {} } }] });
  assert.equal(unknown?.toll.status, "unavailable");
  assert.equal(unknown?.toll.amount, null);

  assert.equal(parseRoutesResponse({}), null);
  assert.equal(parseRoutesResponse({ routes: [{ distanceMeters: "x" }] }), null);
});

const now = new Date("2026-06-01T12:00:00Z");
const toUtc = (d: string, t: string) => new Date(`${d}T${t}:00Z`);
const good = { pickup: { text: "1 Main St" }, dropoff: { text: "Airport" }, stops: [], date: "2026-06-10", time: "09:30", tripType: "distance", passengers: 2 };

test("validateTrip accepts a good trip and rejects bad input", () => {
  assert.equal(validateTrip(good, now, toUtc).ok, true);
  assert.equal(validateTrip({ ...good, pickup: { text: "" } }, now, toUtc).ok, false);
  assert.equal(validateTrip({ ...good, date: "2026-05-01" }, now, toUtc).ok, false); // past
  assert.equal(validateTrip({ ...good, tripType: "hourly" }, now, toUtc).ok, false); // hours missing
  assert.equal(validateTrip({ ...good, tripType: "hourly", hours: 3 }, now, toUtc).ok, true);
  assert.equal(validateTrip({ ...good, passengers: 0 }, now, toUtc).ok, false);
  assert.equal(validateTrip({ ...good, stops: Array(9).fill({ text: "Stop one" }) }, now, toUtc).ok, false);
  assert.equal(validateTrip({ ...good, stops: [{ text: "" }] }, now, toUtc).ok, false);
});

test("validateTrip drops malformed place ids", () => {
  const r = validateTrip({ ...good, pickup: { text: "1 Main St", placeId: "bad id!!" } }, now, toUtc);
  assert.ok(r.ok);
  assert.equal(r.trip.pickup.placeId, undefined);
});

test("notifications: admin alerts carry no personal details; emails escape HTML; customer gets a request-not-confirmed message", () => {
  const built = buildNotification("booking.created", { _id: "abc", Reference: "VT-1001", Customer: "<b>Ann</b>", Email: "ann@example.com", Pickup: "A", Destination: "B", _customerEmail: "ann@example.com", _customerName: "Ann" });
  assert.equal(built.admin!.link, "/admin/bookings/abc");
  assert.ok(!/Ann|ann@|Pickup/.test(built.admin!.title + built.admin!.body));
  assert.deepEqual(built.emails.map((e) => e.audience), ["business", "customer"]);
  assert.match(built.emails[1].intro, /not a confirmed booking/);
  const { html } = renderEmail(built.emails[0]);
  assert.ok(html.includes("&lt;b&gt;Ann&lt;/b&gt;") && !html.includes("<b>Ann"));
  assert.equal(buildNotification("lead.created", { _id: "x", Customer: "C", Email: "c@x.com", Message: "hi" }).emails[0].replyTo!.email, "c@x.com");
  assert.equal(buildNotification("booking.status_changed", { _status: "confirmed", Reference: "VT-1" }).emails.length, 0); // no address: nothing to send
});

test("coverage: DMV / East Coast / other / unknown, never rejecting", () => {
  assert.equal(classifyPlace("123 K St NW, Washington, DC 20001, USA"), "dmv");
  assert.equal(classifyPlace("BWI Airport, Baltimore, MD"), "dmv");
  assert.equal(classifyPlace("Raleigh, NC"), "east_coast");
  assert.equal(classifyPlace("Brooklyn, NY"), "east_coast");
  assert.equal(classifyPlace("West Virginia University"), "other");
  assert.equal(classifyPlace("Los Angeles, CA"), "other");
  assert.equal(classifyPlace("Paris, France"), "other");
  assert.equal(classifyPlace("Somewhere unspecified"), "unknown");
  assert.equal(classifyTrip(["Baltimore, MD", "Philadelphia, PA"]), "east_coast");
  assert.equal(classifyTrip(["Baltimore, MD", "London, England"]), "other");
  assert.equal(fulfilmentFor("dmv").requiresManualReview, false);
  assert.equal(fulfilmentFor("other").requiresManualReview, true);
  assert.ok(looksLikeAirport("Dulles International Airport") && looksLikeAirport("JFK") && !looksLikeAirport("1 Main St"));
});

test("round-trip math: percent and flat discounts exclude tolls; discount never exceeds the fare; waiting increments", () => {
  const cfg: any = { id: "c", vehicleId: "v", status: "active", currency: "USD", baseFare: 0, perMile: 5, hourlyRate: 100, minimumFare: 0, hourlyIncludedMiles: 0, hourlyIncludedScope: "booking", hourlyExtraMileRate: 0, minHours: 2, longTripThresholdMiles: null, longTripPerMile: null, surcharges: [] };
  const leg: any = { tripType: "distance", distanceMiles: 20, durationMinutes: 30, avoidTolls: false, tollAmount: 5, discount: null };
  const pct = calculateRoundTrip(cfg, leg, leg, { id: "r", label: "RT", kind: "percent", amount: 10 });
  assert.ok(pct.ok);
  if (pct.ok) { assert.equal(pct.twoOneWayCents, 2 * (10000 + 500)); assert.equal(pct.discountCents, 2000); assert.equal(pct.totalCents, 21000 - 2000); }
  const flat = calculateRoundTrip(cfg, leg, leg, { id: "r", label: "RT", kind: "flat", amount: 999999 });
  if (flat.ok) assert.equal(flat.discountCents, 20000); // capped at eligible fare, tolls untouched
  const none = calculateRoundTrip(cfg, leg, leg, null);
  if (none.ok) assert.equal(none.discountCents, 0);
  assert.deepEqual(waitingCharge(14, 15, 15, 1000), { billableMinutes: 0, increments: 0, cents: 0 });
  assert.deepEqual(waitingCharge(16, 15, 15, 1000), { billableMinutes: 15, increments: 1, cents: 1000 });
  assert.deepEqual(waitingCharge(46, 15, 15, null), { billableMinutes: 45, increments: 3, cents: null });
  assert.match(waitingPolicyText(15, 15), /includes 15 minutes of waiting time.*15-minute increments/);
});

test("booking details validation: passenger required when booking for someone else, contacts and airport checked", () => {
  const base = { policiesAcknowledged: true };
  assert.equal(validateBookingDetails({ ...base }).ok, true);
  assert.equal(validateBookingDetails({}).ok, false); // policies must be acknowledged
  assert.equal(validateBookingDetails({ ...base, bookingFor: "other", passenger: { name: "", phone: "" } }).ok, false);
  const r = validateBookingDetails({ ...base, bookingFor: "other", passenger: { name: "Grace R", phone: "4105550177" }, contacts: [{ name: "Sam", phone: "4435550123", type: "secondary" }, { name: "", phone: "" }, { name: "Third", phone: "4435550124" }], airport: { airport: "BWI", direction: "arrival", meetGreet: true } });
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.details.contacts.length, 1); assert.equal(r.details.contacts[0].type, "secondary"); assert.equal(r.details.airport!.meetGreet, true); }
  assert.equal(validateBookingDetails({ ...base, contacts: [{ name: "Sam", phone: "12" }] }).ok, false);
  assert.equal(validateBookingDetails({ ...base, airport: { airport: "" } }).ok, false);
});

test("return leg validation: must follow the outbound pickup; hourly trips cannot be round trips", () => {
  const rl = (date: string) => ({ ...good, returnLeg: { pickup: { text: "B" }, dropoff: { text: "A" }, date, time: "10:00" } });
  assert.equal(validateTrip(rl("2026-06-11"), now, toUtc).ok, true);
  assert.equal(validateTrip(rl("2026-06-09"), now, toUtc).ok, false);
  assert.equal(validateTrip({ ...rl("2026-06-11"), tripType: "hourly", hours: 3 }, now, toUtc).ok, false);
});

test("coerceValues enforces the field whitelist, types and required fields", () => {
  const vehicles = resources.vehicles;
  const ok = coerceValues(vehicles, { name: "Test Car", category_id: "11111111-1111-4111-8111-111111111111", passenger_capacity: "4", features: "a, b\nc", is_active: true, evil: "x" }, false);
  assert.ok(ok.ok);
  assert.deepEqual(ok.data.features, ["a", "b", "c"]);
  assert.equal(ok.data.passenger_capacity, 4);
  assert.equal(ok.data.slug, "test-car");
  assert.equal("evil" in ok.data, false);

  assert.equal(coerceValues(vehicles, { name: "X", category_id: "nope", passenger_capacity: 4 }, false).ok, false);
  assert.equal(coerceValues(vehicles, { name: "X", category_id: "11111111-1111-4111-8111-111111111111", passenger_capacity: -2 }, false).ok, false);
  assert.equal(coerceValues(resources.bookings, { status: "hacked" }, true).ok, false);
  const money = coerceValues(resources.bookings, { estimated_fare_cents: "123.45" }, true);
  assert.ok(money.ok);
  assert.equal(money.data.estimated_fare_cents, 12345);
  assert.equal(coerceValues(resources.categories, { name: "A", image_url: "javascript:alert(1)" }, false).ok, false);
});

test("slugify", () => assert.equal(slugify("Mercedes-Benz  S-Class!"), "mercedes-benz-s-class"));

import { decodePolyline } from "../src/lib/geo/polyline.ts";
test("decodePolyline matches Google's documented example", () => {
  const pts = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
  assert.deepEqual(pts, [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});
