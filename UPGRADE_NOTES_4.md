# Upgrade 4: fare modal, vehicle photos, approval-based payment, Track Your Ride, driver chat, helpline

## What was found in the uploaded project (important)
* **The pay link was still released at submission** and checkout was not gated on approval (the older notes said otherwise). Fixed: payment is now impossible until an admin approves and assigns a driver.
* **The admin approve/assign panel was not shown anywhere** (`BookingWorkflow` existed but no page used it, and there was no Drivers page). Both are now wired in.
* The generic admin editor could set `status` directly. It can no longer change status, driver, payment or confirmation fields.
* Online payments are **direct charges** (Stripe Checkout, PayPal capture). There is no authorize-then-capture step in this project, so nothing here relies on an authorization.

## Code changes
| Area | Change |
|---|---|
| Fare modal | Root cause: a later CSS rule re-applied a two-column grid after the mobile one-column rule, so phones kept two squeezed columns. New guarded rules at the end of `globals.css`: full-screen single scrolling column on phones, stacked fields under 560px, 16px inputs, sticky header, section headings. Calculation logic untouched. Escape now also closes when focus is outside the dialog. |
| Vehicle photos | `resolvePhotoSrc` accepts Cloudinary/other https, protocol-relative, http Cloudinary (upgraded) and legacy local raster paths; `.svg` seed illustrations stay placeholders by design. `VehiclePhoto` tries Next's optimiser, then the direct URL, then the placeholder (previously one optimiser failure silently showed the placeholder). `next.config.ts` trims the cloud name. Server logs list vehicles with unusable photo values (no secrets). Same mapping feeds homepage, Rides page and calculator. |
| Submission | Booking gets an unguessable `tracking_code` (`TRK-XXXXX-XXXXX-XXXXX`, 60+ bits). Status stays awaiting review, nothing charged, no pay link. Admin dashboard alert + business email link to `/admin/bookings/<id>`. Customer email carries the tracking ID and link. |
| Approval + payment | Approve assigns a driver and releases payment (existing compare-and-set claim). `startCheckout` and the pay page refuse until released. |
| Verified payment | `recordPaid` claims the payment row (`paid_at IS NULL`) then claims `confirmed_at IS NULL`; only the winner sets status `confirmed` (from `assigned`), writes history, and sends ONE confirmation email (reference, tracking ID/link, pickup, stops, destination, time, vehicle/tier, amount actually paid, helpline). Webhook retries and racing deliveries change nothing. A payment arriving for a cancelled/declined booking is recorded, not confirmed, flagged to admin, never refunded automatically. |
| Tracking | New `/track` page ("Track Your Ride" in header, mobile menu and footer), `POST /api/track`. Lookup only by tracking ID; booking references (`VT-1004`) and private-link tokens are rejected with the same generic 404. Per-IP limits (failed lookups: 10 per 10 min). ID travels in a POST body/header, never a URL; email links use the `#id=` fragment, which is read once and removed. Response excludes phones, emails, notes, full driver name, plate, payment data. Timeline is built only from real facts; cancelled/declined show as ended. |
| Chat | Customer chat via `/api/track/messages` (tracking ID header, sender role forced to customer). Driver chat unchanged: ownership is part of the query, so reassignment revokes the old driver immediately. |
| Calling | No `tel:` link to any customer or driver number anywhere. Customer tracking page and driver page show **Call Vanta Support** using only the helpline (admin setting `contact.phone`, then optional `HELPLINE_PHONE`). Missing number: no button and an admin warning. Driver API no longer returns customer/passenger phones; emails no longer contain driver phone or plate. Admin pages keep their internal contact details. |
| Admin | Booking page now has Approve/assign, Reassign, Decline, Cancel, "Move ride to" (validated transitions, never to confirmed/assigned), status history, tracking ID, confirmed timestamp, helpline warning. New **Drivers** page (add/edit, send sign-in invitation). `confirmed` is labelled "Confirmed". |

## Database (apply in this order, once)
Existing migrations 0001-0008 must already be applied. **Do not re-run them.** Then run only:

1. `supabase/migrations/0009_tracking_confirmation.sql`: adds `bookings.tracking_code` (unique, format check, DB default), `bookings.confirmed_at`, function `new_tracking_code()`, and backfills codes for existing bookings. Additive and idempotent; no drops, deletes or truncates. Existing paid bookings are NOT auto-confirmed and no emails are sent (an optional manual statement is in the file).

RLS: no change needed. `bookings` stays admin-only; customers and drivers reach data only through server routes that verify the tracking ID, private token or driver session with the service role.

## Environment
Nothing new is required. Optional (blank example in `.env.example`): `HELPLINE_PHONE`, used only if Website content > `contact.phone` is empty.

## Manual steps for you
1. Apply migration 0009 in Supabase (SQL editor), then deploy.
2. Admin > Drivers: add drivers (name, email, vehicle), click "Send sign-in invitation".
3. Confirm Website content > `contact.phone` is the real helpline.
4. Stripe/PayPal webhooks must already point at `/api/stripe/webhook` and `/api/paypal/webhook`; confirmation depends on them.
5. Existing bookings: their approval emails already sent contain the older private `/trip/<token>` link, which still works (driver phone removed from it).

## Verification actually performed
* `npm test`: **117 tests, 117 pass** (was 100; all use an in-memory database and mocked Stripe/PayPal/Brevo/Google).
* TypeScript: `tsc` could run only partially here (no `node_modules`, no network, so React/Next/Supabase types are missing). Comparing against the original ZIP shows **no new errors other than missing-type-package noise**. A full `npm run typecheck` must be run after `npm install`.
* **`npm run build` and lint were NOT run** (dependencies cannot be installed offline). Run `npm install && npm run build` before deploying.
* **Not verified against live services**: Supabase, Cloudinary, Stripe, PayPal, Brevo, Vercel. The real cause of placeholders on your live site could not be observed from here; the fix covers every mechanism found in code (unsupported values, optimiser/config mismatch, silent failure), and the server log line `[site] vehicles with an unusable photo value` will name any vehicle still affected.
* Layout was checked by CSS/markup tests, not in a real browser at 320-1280px. Please eyeball the modal on a phone.

## Behaviour decisions to review
* A driver can still move an approved ride forward before payment arrives (existing behaviour). Tell me if rides should be blocked until `confirmed_at` is set.
* An already-open Stripe checkout is not expired when a booking is cancelled; a late payment is handled as described above.
* The stray `..zip` file in the uploaded project root was left out of the returned ZIP.

---
# Follow-up: payment gate on ride progress, security review, verification status

## Payment gate (server-side)
One rule, `rideMayProgress()` in `src/lib/booking-status.ts`: a ride may move to getting ready / on the way / arrived / picked up / completed only if `confirmed_at` is set (set only by the provider-verified payment path), `payment_status` is `paid`, `deposit_paid` or `partially_refunded`, and the booking is not cancelled, declined, no-show or completed.
* `POST /api/driver/status`: refuses with 409 `awaiting_payment`; the final UPDATE repeats the confirmed/paid conditions, so a refund or cancellation landing mid-request wins.
* `POST /api/admin/bookings/workflow` action `advance` ("Move ride to"): same rule.
* Driver ride list sends no next-step buttons and shows "Waiting for payment" until confirmed.
* Unchanged: admin approve/assign before payment, reassign, reject, cancel, no-show.
* Unpaid, failed, expired, pending, in-review and refunded payments never unlock a ride; forging `confirmed_at`/`payment_status` through the generic editor is ignored (tested).

## Tracking and chat review
* Tracking IDs: app-generated codes are 15 characters from a 31-letter alphabet (about 74 bits) using a cryptographic RNG; codes backfilled by migration are 60 bits (random UUID hex). Both are far beyond online guessing. The sequential reference and the private link token are never accepted as tracking IDs. Not guessable from the reference (unrelated random value).
* Public responses exclude phones, emails, notes, full driver name, plate, payment data and the payment token (tested). Tracking IDs are not logged by the new routes; they are in `notification_logs` and `admin_notifications` payloads, which are admin-only.
* Abuse limits: failed tracking lookups 10 per 10 minutes per IP (then 429); 900 requests per 10 minutes per IP overall (raised from 240 because status and chat polling from one phone would otherwise exceed it); customer chat 20 messages per minute per booking and 60 per minute per IP; driver chat 30 per minute per driver; 1-500 character messages, validated server-side, duplicates collapsed by client id. **Limitation:** these counters live in each server instance's memory (the project's existing limiter), so on Vercel they are per-instance, not global. The unguessable ID is the primary defence. A shared limiter (for example Upstash/Redis) would be the next hardening step.

## Migration 0009: is it required, and is it safe?
* **Required.** Without it the app cannot store tracking IDs or `confirmed_at` (bookings would fail to save the new columns).
* Prerequisites verified by reading migrations 0001-0008: `bookings` (0001) with the 13-value status check (0007), `payment_status` and `amount_paid_cents` (0005), `payments.paid_at` (0005), `payment_released_at`/`approved_at`/`driver_id`, `booking_assignments`, `booking_status_history` (0007), `booking_messages` (0008), `gen_random_uuid()` (already used by 0005). Neither new column nor the function exists in 0001-0008.
* Additive and re-runnable: `add column if not exists`, `create or replace function`, `create unique index if not exists`, constraint dropped and re-added by name. No drops, deletes or truncates. Not executed against a real PostgreSQL here (none available): read-checked only, so run it first on a Supabase branch or a backup-restored copy if you can.
* It fills tracking codes for existing bookings (only where null) and, so in-flight rides are not stranded by the new gate, sets `confirmed_at` ONLY on open bookings that already have a provider-verified paid payment row. No emails, no charges.
* **Before deploying, run** the SELECT in the migration's comments. Any approved-but-unpaid open booking it lists will be blocked from progressing until it is paid. If one of those rides is genuinely settled offline, cancel and re-create it, or tell me and I will add an explicit admin "mark paid offline" action; I did not invent one.
* Apply order: 0009 only (0001-0008 must already be applied; never re-run them), then deploy.

## What was and was not run in this environment
* `npm install`: **FAILED**: the sandbox has no network (`ENOTFOUND registry.npmjs.org`), so no dependencies were installed.
* `npm run build`, `npm run lint`, full `tsc` type check: **NOT RUN** (they need the installed dependencies). A partial `tsc` using the TypeScript and Node types that exist offline reports thousands of missing-package errors (React, Next, Supabase). Those are not a pass. Filtering them out, it found one real error from my change (`src/lib/driver/rides.ts`), which is fixed; `.tsx` files cannot be meaningfully type-checked without React types.
* `npm test`: **119 tests, 119 pass** (the project's own runner with in-memory database and mocked Stripe, PayPal, Brevo, Google).
* No live Supabase, Cloudinary, Stripe, PayPal or email service was contacted.
* Run on your machine before deploying: `npm install && npx tsc --noEmit && npm run lint && npm test && npm run build`. Send me the output if anything fails and I will fix it.
