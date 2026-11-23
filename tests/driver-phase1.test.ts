import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { startRideWindow, START_WINDOW_MS, chatAllowedForStatus, CHAT_STATES } from "../src/lib/booking-status.ts";
import { deriveDriverColumns, driverProfileProblem, driverDisplayName, driverInitials } from "../src/lib/driver/profile.ts";
import { resources } from "../src/lib/admin/resources.ts";
import { chatOpen } from "../src/lib/chat-server.ts";
import { validPhotoRef } from "../src/lib/cloudinary.ts";
import { DRIVERS_FOLDER, folderForPurpose, parsePurpose } from "../src/lib/hero.ts";

const NOW = Date.parse("2026-12-01T12:00:00Z");

test("Start Ride opens exactly two hours before pickup and not a second earlier", () => {
  const pickup = new Date(NOW + START_WINDOW_MS).toISOString();                 // pickup is exactly 2h away
  assert.equal(startRideWindow(pickup, NOW).allowed, true);                      // exactly 2h: open
  assert.equal(startRideWindow(pickup, NOW - 1).allowed, false);                 // 1 ms earlier: locked
  assert.equal(startRideWindow(pickup, NOW - 1).opensAt, new Date(NOW).toISOString());
  assert.equal(startRideWindow(new Date(NOW + 5 * 86400_000), NOW).allowed, false); // days ahead: locked
  assert.equal(startRideWindow(new Date(NOW - 3600_000), NOW).allowed, true);    // pickup time already passed: still allowed
  assert.deepEqual(startRideWindow("not a date", NOW), { allowed: false, opensAt: null });
  assert.deepEqual(startRideWindow(null, NOW), { allowed: false, opensAt: null });
});

test("chat opens only once the driver started the ride or is on the way, and only with an assigned driver", () => {
  for (const s of ["pending", "approved", "assigned", "confirmed", "completed", "cancelled", "rejected"]) assert.equal(chatAllowedForStatus(s), false, s);
  for (const s of CHAT_STATES) assert.equal(chatAllowedForStatus(s), true, s);
  assert.equal(chatOpen({ status: "assigned", driver_id: "d" }), false);
  assert.equal(chatOpen({ status: "on_the_way", driver_id: "d" }), true);
  assert.equal(chatOpen({ status: "getting_ready", driver_id: "d" }), true);
  assert.equal(chatOpen({ status: "on_the_way", driver_id: null }), false);
  assert.equal(chatOpen({ status: "completed", driver_id: "d" }), false);       // closes with the ride
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

test("admin driver form uses only the approved fields and no phone number", () => {
  const names = resources.drivers.fields.map((f) => f.name);
  assert.deepEqual(names.filter((n) => !["notes", "is_active", "email", "image_public_id"].includes(n)), ["first_name", "last_name", "preferred_name", "vehicle_year", "vehicle_make", "vehicle_model", "vehicle_plate", "location", "preferred_area", "image_url"]);
  assert.ok(!names.includes("phone"));
  const req = (n: string) => resources.drivers.fields.find((f) => f.name === n)?.required;
  for (const n of ["first_name", "last_name", "vehicle_year", "vehicle_make", "vehicle_model", "vehicle_plate", "location"]) assert.equal(req(n), true, n);
  for (const n of ["preferred_name", "preferred_area", "image_url"]) assert.ok(!req(n), n);
  assert.ok(!resources.drivers.select.split(",").includes("phone"));
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
  for (const id of ["a-inst", "a-airline", "a-ftime", "a-term"]) assert.ok(details.includes(`id="${id}"`), id);
});
