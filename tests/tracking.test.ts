// Pure and static checks: tracking IDs, progress timeline, helpline parsing, vehicle photo resolution,
// the mobile fare-calculator CSS/markup, and "no direct calling" in customer-facing code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { generateTrackingCode, normalizeTrackingCode, looksLikeBookingReference, buildTimeline, firstName, TRACKING_CODE_RE } from "../src/lib/tracking.ts";
import { parseHelpline } from "../src/lib/helpline.ts";
import { resolvePhotoSrc, photoUrl, describePhotoProblem, hasRealPhoto } from "../src/lib/vehicle-photo.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const walk = (d: string): string[] => readdirSync(path.join(root, d)).flatMap((n) => { const rel = `${d}/${n}`; return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel]; });

test("tracking IDs: random, well-formed, forgiving to type, never confused with booking references", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) { const c = generateTrackingCode(); assert.match(c, TRACKING_CODE_RE); seen.add(c); }
  assert.equal(seen.size, 2000);
  assert.ok(![...seen].some((c) => /[01OIL]/.test(c.slice(4).replace(/-/g, "")))); // no look-alike characters
  assert.equal(normalizeTrackingCode(" trk 7q2mk.9xh4d-b6twa "), "TRK-7Q2MK-9XH4D-B6TWA");
  assert.equal(normalizeTrackingCode("7Q2MK9XH4DB6TWA"), "TRK-7Q2MK-9XH4D-B6TWA");
  for (const bad of ["VT-1004", "TRK-1", "", "x".repeat(100), null, undefined, 5, {}, "TRK-7Q2MK-9XH4D-B6TW!"]) assert.equal(normalizeTrackingCode(bad as unknown), null, String(bad));
  assert.ok(looksLikeBookingReference("VT-1004") && looksLikeBookingReference(" vt1004 ") && !looksLikeBookingReference("TRK-7Q2MK-9XH4D-B6TWA"));
  // Database-generated codes (upper-case hex) are accepted by the same rules.
  assert.equal(normalizeTrackingCode("TRK-0A1B2-C3D4E-F5A6B"), "TRK-0A1B2-C3D4E-F5A6B");
});

const F = (o: Partial<Parameters<typeof buildTimeline>[0]> = {}) => ({ status: "new_request" as const, hasDriver: false, released: false, paid: false, confirmed: false, ...o });
const done = (t: ReturnType<typeof buildTimeline>) => t.steps.filter((s) => s.state === "done").map((s) => s.key);

test("timeline: only facts become progress; terminal states are shown as ended, never as success", () => {
  assert.equal(buildTimeline(F()).headline, "Awaiting approval");
  assert.deepEqual(done(buildTimeline(F())), ["received"]);
  const approved = buildTimeline(F({ status: "assigned", hasDriver: true, released: true }));
  assert.equal(approved.headline, "Approved: awaiting payment");
  assert.deepEqual(done(approved), ["received", "approved", "driver"]);
  assert.equal(approved.steps.find((s) => s.state === "current")!.key, "payment");
  const confirmed = buildTimeline(F({ status: "confirmed", hasDriver: true, released: true, paid: true, confirmed: true }));
  assert.equal(confirmed.headline, "Booking confirmed");
  assert.ok(done(confirmed).includes("confirmed"));
  assert.equal(buildTimeline(F({ status: "on_the_way", hasDriver: true, released: true, paid: true, confirmed: true })).headline, "Your driver is on the way");
  const finished = buildTimeline(F({ status: "completed", hasDriver: true, released: true, paid: true, confirmed: true }));
  assert.equal(finished.headline, "Ride completed"); assert.equal(done(finished).length, 10);
  // Approved but unpaid and the driver is already on the way: payment is NOT shown as done.
  const unpaidRide = buildTimeline(F({ status: "on_the_way", hasDriver: true, released: true }));
  assert.ok(!done(unpaidRide).includes("payment") && !done(unpaidRide).includes("confirmed"));
  for (const [status, label] of [["rejected", "Request declined"], ["cancelled", "Booking cancelled"], ["no_show", "Marked as no-show"]] as const) {
    const t = buildTimeline(F({ status, hasDriver: status !== "rejected", released: status !== "rejected" }));
    assert.equal(t.ended, true); assert.equal(t.headline, label);
    const last = t.steps[t.steps.length - 1]; assert.equal(last.ended, true); assert.equal(last.label, label);
    assert.ok(!t.steps.some((s) => s.key === "completed" || s.key === "confirmed"));
    assert.ok(t.steps.slice(0, -1).every((s) => s.state === "done"));
  }
  assert.equal(firstName("Dana Marie Driver"), "Dana"); assert.equal(firstName(""), null); assert.equal(firstName(null), null);
});

test("helpline: only a plausible configured number becomes a tel: target; nothing is invented", () => {
  assert.deepEqual(parseHelpline("+1 555-010-0199"), { display: "+1 555-010-0199", tel: "+15550100199" });
  assert.deepEqual(parseHelpline("(410) 555-0100"), { display: "(410) 555-0100", tel: "+14105550100" });
  assert.equal(parseHelpline(""), null); assert.equal(parseHelpline("call us"), null); assert.equal(parseHelpline(undefined), null); assert.equal(parseHelpline("12"), null);
});

test("vehicle photos: Cloudinary, other https, legacy local photos and bad values", () => {
  const c = "https://res.cloudinary.com/democloud/image/upload/v1/vanta/vehicles/x.jpg";
  assert.equal(resolvePhotoSrc(c), c);
  assert.equal(resolvePhotoSrc(`  ${c}  `), c);
  assert.equal(resolvePhotoSrc("http://res.cloudinary.com/democloud/image/upload/v1/a.jpg"), "https://res.cloudinary.com/democloud/image/upload/v1/a.jpg");
  assert.equal(resolvePhotoSrc("https://abc.supabase.co/storage/v1/object/public/site-images/v.png"), "https://abc.supabase.co/storage/v1/object/public/site-images/v.png");
  assert.equal(resolvePhotoSrc("/vehicles/photo.JPG"), "/vehicles/photo.JPG");                   // legacy local photo kept working
  assert.equal(resolvePhotoSrc("//cdn.example.com/a.jpg"), "https://cdn.example.com/a.jpg");
  for (const none of ["/vehicles/sedan.svg", "", "   ", null, undefined, 7, "javascript:alert(1)", "/../etc/passwd.jpg", "http://evil.example/x.jpg", "data:image/png;base64,AAA"]) assert.equal(resolvePhotoSrc(none as unknown), null, String(none));
  assert.ok(hasRealPhoto(c) && !hasRealPhoto("/vehicles/van.svg"));
  assert.equal(describePhotoProblem(null), null);                                                   // genuinely missing: no warning
  assert.match(describePhotoProblem("/vehicles/van.svg")!, /illustration/);
  assert.match(describePhotoProblem("ftp://x")!, /unsupported/);
  // Transformations are added once, only to Cloudinary URLs.
  const t = photoUrl(c, 640, 400); assert.ok(t.includes("/upload/f_auto,q_auto,c_fill,g_auto,w_640,h_400/v1/")); assert.equal(photoUrl(t, 640, 400), t);
  assert.equal(photoUrl("https://abc.supabase.co/a.jpg", 640, 400), "https://abc.supabase.co/a.jpg");
});

test("vehicle photo component: optimiser first, then direct URL, then a polished placeholder; config trims the cloud name", () => {
  const vp = read("src/components/VehiclePhoto.tsx");
  assert.ok(vp.includes("unoptimized={stage === 1}") && vp.includes("Photo coming soon") && vp.includes("onError={fail}"));
  assert.ok(read("next.config.ts").includes('.trim()'));
  // Both public pages render vehicle cards through the same photo component with the saved value.
  assert.ok(read("src/components/Sections.tsx").includes("VehiclePhoto"));
});

test("fare calculator modal: single scrolling column on phones, stacked fields, accessible dialog", () => {
  const css = read("src/app/globals.css");
  const tail = css.slice(css.lastIndexOf("Calculate Your Fare modal: responsive layout"));
  assert.match(tail, /@media \(max-width: 860px\)[\s\S]*\.calc__body \{ display: block;[^}]*overflow-y: auto/);
  assert.match(tail, /@media \(max-width: 560px\)[\s\S]*\.calc__row \{ grid-template-columns: 1fr/);
  assert.match(tail, /\.calc \{ width: 100%; height: 100dvh/);
  assert.match(tail, /font-size: 16px/);
  // The desktop two-column rule must not come AFTER the mobile rules without a min-width guard (the original bug).
  const unguarded = css.slice(0, css.lastIndexOf("Calculate Your Fare modal: responsive layout")).match(/\n\.calc__body \{ grid-template-columns: minmax\(0, \.85fr\)[^}]*\}/g);
  assert.ok(unguarded && tail.includes("@media (min-width: 861px)")); // still present earlier, but overridden by the guarded rule below it
  const calc = read("src/components/FareCalculator.tsx");
  for (const must of ['role="dialog"', 'aria-modal="true"', 'aria-labelledby="calc-title"', 'aria-label="Close fare calculator"', 'e.key === "Escape"', "prev?.focus"]) assert.ok(calc.includes(must), must);
  assert.ok(calc.includes('className="calc__section"'));
  // Calculation logic untouched.
  for (const must of ["/api/fare/quote", "onlineTotal", "continueToBooking", "Request a Better Quote"]) assert.ok(calc.includes(must), must);
});

test("no direct calling of customers or drivers; only the configured helpline; Track Your Ride in the navigation", () => {
  const files = [...walk("src/components"), ...walk("src/app"), ...walk("src/lib")].filter((f) => /\.(tsx?|ts)$/.test(f));
  const telUses = files.filter((f) => /tel:/.test(read(f)));
  // Allowed: the business phone in footer/contact (site content), the helpline button, and docs inside helpline.ts.
  // (the admin leads page and the admin overview's driver-acknowledgement follow-up list keep staff-only phone links: internal contact details stay inside the protected dashboard)
  assert.deepEqual(telUses.sort(), ["src/app/(site)/contact/page.tsx", "src/app/admin/(panel)/leads/[id]/page.tsx", "src/app/admin/(panel)/page.tsx", "src/components/SiteFooter.tsx", "src/components/TripStatus.tsx", "src/components/driver/DriverDashboard.tsx", "src/lib/helpline.ts"].sort());
  for (const f of ["src/components/TripStatus.tsx", "src/components/driver/DriverDashboard.tsx"]) assert.ok(read(f).includes("helpline.tel"), f);
  assert.ok(!/passengerPhone|contactPhone|driver\.phone|Driver phone/.test([...walk("src/components"), "src/lib/trip.ts", "src/lib/driver/rides.ts", "src/lib/notify/templates.ts"].map(read).join("\n")));
  const nav = read("src/components/SiteHeader.tsx");
  assert.ok(nav.includes('"/track"') && nav.includes("Track Your Ride"));
  assert.ok(read("src/components/SiteFooter.tsx").includes('"/track"'));
});

test("migration 0009 is additive and idempotent", () => {
  const sql = read("supabase/migrations/0009_tracking_confirmation.sql");
  assert.ok(!/\bdrop\s+(table|column)\b|\btruncate\b|\bdelete\s+from\b/i.test(sql));
  assert.ok(/create or replace function public\.new_tracking_code/.test(sql) && /add column if not exists tracking_code/.test(sql) && /add column if not exists confirmed_at/.test(sql));
  assert.ok(/create unique index if not exists bookings_tracking_code_key/.test(sql) && /where b\.tracking_code is null/.test(sql));
});
