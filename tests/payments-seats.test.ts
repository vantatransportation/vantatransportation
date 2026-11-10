import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { paymentPlan, statusAfterPayment, MIN_CHARGE_CENTS } from "../src/lib/payments.ts";
import { signStripePayload, verifyStripeSignature } from "../src/lib/stripe-signature.ts";
import { childSeatFee, childSeatSummary, parseChildSeats, NO_SEATS } from "../src/lib/child-seats.ts";
import { hasRealPhoto, isCloudinaryUrl, photoUrl } from "../src/lib/vehicle-photo.ts";
import { BETTER_QUOTE_DISCLAIMER } from "../src/lib/policy-text.ts";

const base = { depositFixedCents: null, depositPercent: null, terms: null };

test("payment plan: disabled by default; full, fixed and percent deposits; never invents an amount", () => {
  assert.equal(paymentPlan({ ...base, mode: "disabled" }, 20000, 0), null);
  assert.deepEqual(paymentPlan({ ...base, mode: "full" }, 20000, 0), { kind: "full", amountCents: 20000 });
  assert.deepEqual(paymentPlan({ ...base, mode: "deposit_fixed", depositFixedCents: 5000 }, 20000, 0), { kind: "deposit", amountCents: 5000 });
  assert.deepEqual(paymentPlan({ ...base, mode: "deposit_percent", depositPercent: 25 }, 20000, 0), { kind: "deposit", amountCents: 5000 });
  assert.deepEqual(paymentPlan({ ...base, mode: "deposit_fixed", depositFixedCents: 99999 }, 20000, 0), { kind: "full", amountCents: 20000 }); // capped at the total
  assert.equal(paymentPlan({ ...base, mode: "deposit_fixed" }, 20000, 0), null);            // deposit not configured
  assert.equal(paymentPlan({ ...base, mode: "deposit_percent", depositPercent: 0 }, 20000, 0), null);
  assert.equal(paymentPlan({ ...base, mode: "full" }, null, 0), null);                      // no price: nothing to charge
  assert.equal(paymentPlan({ ...base, mode: "full" }, 0, 0), null);
  assert.deepEqual(paymentPlan({ ...base, mode: "full" }, 20000, 5000), { kind: "full", amountCents: 15000 }); // remaining balance
  assert.equal(paymentPlan({ ...base, mode: "deposit_fixed", depositFixedCents: 5000 }, 20000, 5000), null);    // deposit already paid
  assert.equal(paymentPlan({ ...base, mode: "full" }, MIN_CHARGE_CENTS - 1, 0), null);       // below the card minimum
  assert.equal(statusAfterPayment(20000, 5000), "deposit_paid");
  assert.equal(statusAfterPayment(20000, 20000), "paid");
  assert.equal(statusAfterPayment(20000, 0), "unpaid");
});

test("Stripe signature: valid, tampered body, wrong secret, stale timestamp, malformed header", () => {
  const secret = "whsec_unit"; const body = '{"id":"evt_1"}'; const now = 1_800_000_000;
  const good = signStripePayload(body, secret, now);
  assert.equal(verifyStripeSignature(body, good, secret, now), true);
  assert.equal(verifyStripeSignature(body + " ", good, secret, now), false);
  assert.equal(verifyStripeSignature(body, good, "whsec_other", now), false);
  assert.equal(verifyStripeSignature(body, good, secret, now + 301), false); // replay window
  assert.equal(verifyStripeSignature(body, "garbage", secret, now), false);
  assert.equal(verifyStripeSignature(body, null, secret, now), false);
  assert.equal(verifyStripeSignature(body, good, "", now), false);
  assert.equal(verifyStripeSignature(body, `t=${now},v1=zz`, secret, now), false);
});

test("child seats: per-seat pricing, round-trip rate charged once, validation limits", () => {
  const cfg = { oneWayCents: 1000, roundTripCents: 1500, max: 4 };
  const seats = { rear_facing: 1, front_facing: 0, booster: 2 };
  assert.equal(childSeatFee(seats, false, cfg).totalCents, 3000);
  assert.equal(childSeatFee(seats, true, cfg).totalCents, 4500); // 3 seats x $15, not x2 legs
  assert.equal(childSeatFee(NO_SEATS, true, cfg).totalCents, 0);
  assert.equal(childSeatSummary(seats), "1 × Rear-facing, 2 × Booster");
  assert.ok(parseChildSeats({ booster: 2 }, 3, 4).ok);
  assert.equal(parseChildSeats({ booster: 5 }, 9, 4).ok, false);   // above the configured maximum
  assert.equal(parseChildSeats({ booster: 3 }, 2, 4).ok, false);   // more seats than passengers
  assert.equal(parseChildSeats({ booster: 1.5 }, 3, 4).ok, false); // whole numbers only
  assert.equal(parseChildSeats({ booster: -1 }, 3, 4).ok, false);
  assert.ok(parseChildSeats(undefined, 1, 4).ok);
});

test("vehicle photos: only https images count; Cloudinary URLs get transformations; others are left alone", () => {
  assert.equal(hasRealPhoto("/vehicles/van.svg"), false);
  assert.equal(hasRealPhoto(null), false);
  assert.equal(hasRealPhoto("https://res.cloudinary.com/demo/image/upload/v1/vanta/vehicles/a.jpg"), true);
  assert.equal(isCloudinaryUrl("https://res.cloudinary.com/demo/image/upload/a.jpg", "demo"), true);
  assert.equal(isCloudinaryUrl("https://res.cloudinary.com/other/image/upload/a.jpg", "demo"), false);
  assert.equal(isCloudinaryUrl("https://evil.example/demo/a.jpg", "demo"), false);
  assert.match(photoUrl("https://res.cloudinary.com/demo/image/upload/v1/x.jpg", 640, 400), /\/upload\/f_auto,q_auto,c_fill,g_auto,w_640,h_400\/v1\/x\.jpg/);
  assert.equal(photoUrl("https://example.com/a.jpg", 640, 400), "https://example.com/a.jpg");
});

// ---- wording and labels across the active source -------------------------------------------------
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const src = walk(new URL("../src", import.meta.url).pathname).filter((f) => /\.(tsx?|css)$/.test(f));

test("no 'Economical' label remains in active source or seed data; tiers are Business Class / First Class", () => {
  const hits = src.filter((f) => /economical/i.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits, []);
  assert.ok(!/economical/i.test(readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8")));
  const defaults = readFileSync(new URL("../src/data/defaults.ts", import.meta.url), "utf8");
  assert.ok(defaults.includes('tierName: "Business Class"') && defaults.includes('tierName: "First Class"'));
  for (const label of ["11–14 passengers", "6–7 passengers", "2–3 passengers"]) assert.ok(defaults.includes(label), label);
});

test("Better Quote disclaimer: one wording used in the FAQ, the request form, the confirmation and seed data", () => {
  assert.match(BETTER_QUOTE_DISCLAIMER, /does not guarantee a lower price or discount/);
  assert.match(BETTER_QUOTE_DISCLAIMER, /case-by-case basis/);
  const calc = readFileSync(new URL("../src/components/FareCalculator.tsx", import.meta.url), "utf8");
  assert.ok((calc.match(/BETTER_QUOTE_DISCLAIMER/g) ?? []).length >= 3);   // import + beside the question + beside the submit button
  assert.ok(calc.includes("BETTER_QUOTE_REMINDER"));                         // reminder in the confirmation
  for (const f of ["../src/data/defaults.ts", "../supabase/seed.sql", "../supabase/migrations/0005_tiers_photos_seats_payments.sql"]) {
    assert.ok(readFileSync(new URL(f, import.meta.url), "utf8").includes(BETTER_QUOTE_DISCLAIMER), f); // FAQ text
  }
  const forbidden = /guarantee(d)? (a )?(lower|discount|approval)|we will (lower|match|beat)/i;
  assert.ok(!forbidden.test(BETTER_QUOTE_DISCLAIMER.replace(/does not guarantee a lower price or discount/, "")));
});
