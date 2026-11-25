import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { chatOpensAt, chatWindowOpen, CHAT_OPENS_BEFORE_MS } from "../src/lib/booking-status.ts";
import { deriveDriverColumns, driverProfileProblem, driverDisplayName, driverInitials } from "../src/lib/driver/profile.ts";
import { resources } from "../src/lib/admin/resources.ts";
import { chatOpen } from "../src/lib/chat-server.ts";
import { validPhotoRef } from "../src/lib/cloudinary.ts";
import { DRIVERS_FOLDER, folderForPurpose, parsePurpose } from "../src/lib/hero.ts";

const NOW = Date.parse("2026-12-01T12:00:00Z");

test("chat window opens exactly 24 hours before pickup, and only then (pure rule)", () => {
  const pickup = new Date(NOW + CHAT_OPENS_BEFORE_MS).toISOString();
  assert.equal(chatWindowOpen(pickup, NOW), true);                 // exactly 24h before
  assert.equal(chatWindowOpen(pickup, NOW - 1), false);            // one millisecond earlier
  assert.equal(chatOpensAt(pickup), new Date(NOW).toISOString());
  assert.equal(chatWindowOpen(new Date(NOW + 5 * 86400_000), NOW), false);
  assert.equal(chatWindowOpen(new Date(NOW - 3600_000), NOW), true); // pickup time already passed: still inside the window (the ride state decides when it closes)
  assert.equal(chatWindowOpen("not a date", NOW), false); assert.equal(chatWindowOpen(null, NOW), false);
});

test("chat is open only for an assigned driver, a confirmed and paid booking, an unfinished ride, inside the 24-hour window", () => {
  const base = { status: "assigned", driver_id: "d", confirmed_at: "2026-12-01T00:00:00Z", payment_status: "paid", pickup_at: new Date(NOW + 3600_000).toISOString() };
  assert.equal(chatOpen(base, NOW), true);
  for (const s of ["getting_ready", "on_the_way", "arrived", "picked_up", "in_progress"]) assert.equal(chatOpen({ ...base, status: s }, NOW), true, s);
  for (const s of ["completed", "cancelled", "rejected", "no_show", "pending_confirmation"]) assert.equal(chatOpen({ ...base, status: s }, NOW), false, s);
  assert.equal(chatOpen({ ...base, driver_id: null }, NOW), false);
  assert.equal(chatOpen({ ...base, confirmed_at: null }, NOW), false);       // not confirmed
  assert.equal(chatOpen({ ...base, payment_status: "unpaid" }, NOW), false); // payment not verified
  assert.equal(chatOpen({ ...base, pickup_at: new Date(NOW + 25 * 3600_000).toISOString() }, NOW), false); // 25h away
});

test("driver profile: required fields, derived legacy columns, display name", () => {
  const ok = { first_name: "Dana", last_name: "Marie", vehicle_year: 2022, vehicle_make: "Cadillac", vehicle_model: "Escalade", vehicle_plate: "VT-123", location: "Baltimore" };
  assert.equal(driverProfileProblem(ok), null);
  for (const k of ["first_name", "last_name", "vehicle_make", "vehicle_model", "vehicle_plate", "location"]) assert.match(driverProfileProblem({ ...ok, [k]: " " }) ?? "", /required/, k);
  assert.match(driverProfileProblem({ ...ok, vehicle_year: 1900 }) ?? "", /year/);
  assert.match(driverProfileProblem({ ...ok, vehicle_year: "abc" }) ?? "", /year/);
  assert.deepEqual(deriveDriverColumns(ok), { full_name: "Dana Marie", vehicle_description: "2022 Cadillac Escalade" });
  assert.equal(driverDisplayName({ ...ok, preferred_name: "Dani" }), "Dani");   // preferred name wins
  assert.equal(driverDisplayName(ok), "Dana");                                   // otherwise first name, never the surname
  assert.equal(driverDisplayName({ full_name: "Legacy Driver" }), "Legacy");     // legacy rows without the new columns still work
  assert.equal(driverInitials("Dana Marie"), "DM"); assert.equal(driverInitials(null), "V");
});

test("admin driver form has the approved fields, including the restored company-only phone", () => {
  const names = resources.drivers.fields.map((f) => f.name);
  assert.deepEqual(names.filter((n) => !["notes", "is_active", "email", "image_public_id", "phone"].includes(n)), ["first_name", "last_name", "preferred_name", "vehicle_year", "vehicle_make", "vehicle_model", "vehicle_plate", "location", "preferred_area", "image_url"]);
  assert.ok(names.includes("phone"));                                             // restored: company and admin use only
  assert.notEqual(resources.drivers.fields.find((f) => f.name === "phone")?.required, true); // optional, so existing drivers are not blocked
  const req = (n: string) => resources.drivers.fields.find((f) => f.name === n)?.required;
  for (const n of ["first_name", "last_name", "vehicle_year", "vehicle_make", "vehicle_model", "vehicle_plate", "location"]) assert.equal(req(n), true, n);
  for (const n of ["preferred_name", "preferred_area", "image_url"]) assert.ok(!req(n), n);
  assert.ok(resources.drivers.select.split(",").includes("phone"));
});

test("driver pictures use the existing Cloudinary uploader in their own folder", () => {
  assert.equal(parsePurpose("drivers"), "drivers"); assert.equal(folderForPurpose("drivers"), DRIVERS_FOLDER);
  assert.equal(parsePurpose("anything"), "vehicles");
  const cloud = process.env.CLOUDINARY_CLOUD_NAME ?? "demo";
  void cloud;
  assert.equal(validPhotoRef("https://res.cloudinary.com/x/image/upload/v1/vanta/vehicles/a.jpg", "vanta/vehicles/a", DRIVERS_FOLDER), false); // a vehicle asset cannot be used as a driver picture
  assert.equal(validPhotoRef("https://evil.example/a.jpg", `${DRIVERS_FOLDER}/a`, DRIVERS_FOLDER), false);
});

test("migration 0012 is additive and non-destructive", () => {
  const files = readdirSync("supabase/migrations").filter((f) => f.startsWith("0012"));
  assert.equal(files.length, 1);
  const sql = readFileSync(`supabase/migrations/${files[0]}`, "utf8").toLowerCase();
  assert.ok(!/drop\s+(table|column)|truncate|delete\s+from/.test(sql));
  for (const c of ["first_name", "last_name", "preferred_name", "vehicle_year", "vehicle_make", "vehicle_model", "location", "preferred_area", "image_url", "image_public_id"]) assert.ok(sql.includes(`add column if not exists ${c}`), c);
});

test("airport form keeps the essentials visible and moves the rest into a collapsible Additional information section", () => {
  const f = readFileSync("src/components/BookingForm.tsx", "utf8");
  const start = f.indexOf("Additional information");
  const details = f.slice(f.lastIndexOf("<details", start), f.indexOf("</details>", start));
  for (const id of ["a-airport", "a-dir", "a-flight", "a-fdate", "a-pname"]) assert.ok(f.includes(`id="${id}"`) && !details.includes(`id="${id}"`), id);
  assert.match(details, /Additional information/);
  assert.ok(details.includes('id="a-inst"'));
  for (const id of ["a-airline", "a-ftime", "a-term"]) assert.ok(!f.includes(`id="${id}"`), `${id} must not be on the customer form`); // airline, flight time and terminal were removed
});

test("Getting Ready is the acknowledgement button with the exact label, no time lock; Leave for Pickup stays the gated step", () => {
  const dash = readFileSync("src/components/driver/DriverDashboard.tsx", "utf8");
  assert.match(dash, /getting_ready: "Getting Ready"/);
  assert.match(dash, /on_the_way: "Leave for pickup"/);
  assert.ok(!/s === "getting_ready" &&[^\n]*locked|startOpensAt/.test(dash), "Getting Ready must not be time-locked in the UI");
  const route = readFileSync("src/app/api/driver/status/route.ts", "utf8");
  assert.ok(!/startRideWindow|START_RIDE_STATUS/.test(route), "the server must not time-gate Getting Ready");
  assert.match(route, /LEAVE_FOR_PICKUP_STATUS/); assert.match(route, /too_early/);
});

test("the proposals document exists and the unapproved features are not implemented", () => {
  const doc = readFileSync("docs/PROPOSALS.md", "utf8");
  for (const h of ["Time zones and rescheduled bookings", "sedan booked, SUV required", "authorize now, capture on approval", "Flight tracking: out of scope"]) assert.ok(doc.includes(h), h);
  assert.ok(!/AeroAPI|FlightAware|Aviationstack/i.test(doc), "flight-provider research is out of scope");
  const all = readdirSync("src/app/api", { recursive: true }).map(String);
  assert.ok(!all.filter((f) => !/paypal/i.test(f)).some((f) => /flight|capture|vehicle-change|pickup-change/i.test(f)), // the existing PayPal capture route is unrelated and stays
     "no flight, capture, SUV-upgrade or pickup-change endpoints may exist before approval");
  assert.ok(!readFileSync("src/lib/payments-server.ts", "utf8").includes("capture_method"));
});
