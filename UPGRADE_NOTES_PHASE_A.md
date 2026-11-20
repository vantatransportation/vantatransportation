# Vanta upgrade - Phases A, B1, B2 (approval workflow, drivers, rush hour, tips, luggage, driver dashboard, customer booking page, chat)

This is the first, verified slice of the large upgrade spec. It is NOT the whole spec: see "Not done yet" below.

## Decisions recorded (confirmed by the owner)
- Rush-hour surcharge and percentage tips are calculated on the **fixed tier price** (the amount customers are charged online today). Meet & Greet, child seats, waiting and cleanup fees are never part of that base.
- Payment is created **only after admin approval and driver assignment**. Submitting a request creates no pay link and no Stripe/PayPal session.
- Existing PayPal support is left untouched.

## What changed
- Booking submission: no payment link; request saved as "Awaiting review"; customer email says no payment has been taken.
- Admin booking page: **Approve & assign driver**, **Reassign**, **Decline** (reason emailed), **Cancel** (reason). Each is a conditional database update, so double-clicks and two admins cannot both succeed; one open assignment per booking is enforced by a partial unique index. Status history is recorded.
- Checkout (`startCheckout`) refuses until `payment_released_at` and `driver_id` are set. The pay page explains the request is under review.
- Cancelling never refunds automatically; if a payment was received the admin is told to review a refund manually.
- Admin > Drivers (add/edit/activate/deactivate), Booking settings > rush-hour fields (enabled, %, windows JSON, time zone; validated server-side).
- Rush-hour: 5% default, 8-10 AM and 4-6 PM, evaluated in the configured zone, once per booking, overlap of [pickup, pickup + route duration], midnight-crossing windows and DST handled; round trip = once if either leg overlaps.
- Tips: 15 / 20 / 25 % / custom / none; custom validated (no negatives, exponents, >2 decimals, over $10,000). Persisted with the booking; shown in the fare breakdown and as separate Stripe line items.
- Luggage: checked and carry-on bag fields (0-50) with a vehicle-capacity note; saved and shown in admin and driver-assignment email.
- Water-only / cleanup wording shown in the booking policies (no fee amounts invented).
- Contact email default changed to vantatransportation.1@gmail.com (still editable in Admin > Website content; migration only replaces the old placeholder).
- Generic Bookings edit can no longer set `assigned`/`rejected`/`cancelled` or make invalid status jumps.

## SQL to run (Supabase SQL editor), in order
Already applied: 0001-0006. New: **0007_approval_drivers_tips_rush.sql** (additive, idempotent). Read its BACKFILL note: bookings that were already assigned/confirmed before this migration are not auto-released for payment.

## Environment variables
No new variables. `.env.example` only changes the default business email.

## Tests (run here)
`npx tsc --noEmit` clean; `npm test`: 107/107 pass (90 existing + 17 new: rush windows/DST/midnight/once-only, tips, status machine, approve-then-pay, concurrent approvals, reassignment, reject/cancel, itemised Stripe lines, luggage).
Lint: no new errors versus the uploaded ZIP (the existing 101 errors are pre-existing, mostly `any` in tests).
**Production build was NOT verified**: `next build` fails in the sandbox only because it cannot download Google Fonts. Run `npm run build` locally or on Vercel.
Not tested against live Supabase, Stripe, PayPal, Brevo, Cloudinary or Google (tests use an in-memory database and mocked network). Apply 0007 to a staging project first.

## Vehicle images
This ZIP already contains the earlier fix (public pages revalidated after admin saves; read errors logged). Not re-verified against live Cloudinary/Supabase.

## Phase B1: driver accounts and dashboard (added)
- `/driver/login`, `/driver` (mobile-first: In progress / Upcoming / Recent, large buttons), `/driver/set-password`. Separate cookies (`vd_at`, `vd_rt`) from the admin session: a driver session is never an admin session and vice versa.
- Access requires a valid Supabase session AND a `drivers` row linked to that user AND `is_active`. Deactivating a driver cuts access immediately.
- A driver sees only rides where `driver_id` is their own verified id (taken from the session, never the request). No pricing, payment, tokens, internal notes or customer email in any driver response. Customer/passenger phone and notes appear only while a ride is open; `tel:` call buttons use them.
- Status buttons: Getting ready, On the way, Arrived, Picked up, Complete. Server-side: own ride only (another driver's ride returns 404), valid next step only, compare-and-set (double taps cannot apply twice), history recorded. Customer is emailed once when the driver is on the way / has arrived. Drivers cannot cancel, record no-shows, reassign or touch pricing.
- Admin > Drivers: "Send sign-in invitation" (Supabase invite email; the driver chooses their own password, nobody sees it). Refuses emails that already have an account (e.g. an admin).
- Assignment emails now link to `/driver`.

### Supabase configuration needed for driver invitations
1. Authentication > URL Configuration: set Site URL to your site and add `https://YOUR-DOMAIN/driver/set-password` to Redirect URLs.
2. Authentication > Email: keep "Invite user" emails enabled (default Supabase email works for low volume; configure custom SMTP for production).
3. `NEXT_PUBLIC_SITE_URL` must be set (already required elsewhere).
Manual test: add a driver in Admin > Drivers with a real inbox, send the invitation, open the link, set a password, sign in at /driver, approve a booking to that driver from the booking page, confirm it appears, tap through the statuses.
Tests added (5): signed-out/admin-cookie/unlinked users refused; driver cookie is not an admin session; per-driver isolation and no data leakage; status rules, double-tap, history; reassignment revokes old driver; deactivation; invite password only for linked drivers. Not tested: the real Supabase invite email and sign-in (the sign-in route is code-reviewed only; the in-memory test database has no password login).

## Phase B2: customer booking page, chat, call buttons (added)
SQL: run **0008_chat.sql** after 0007 (one new table, `booking_messages`, admin-only RLS).
- `/trip/<private-token>`: the customer's booking page. The unguessable booking token (the same one the pay link uses) is the credential, so guests need no account and nobody can reach a booking by guessing an id. The page is `noindex` with `no-referrer`. It shows approval status and a progress list, trip and luggage, itemised charges, the **Pay securely online** button once payment is released, and the assigned driver's name, vehicle, plate and a **Call driver** (`tel:`) button only while a driver is assigned and the ride is open. It never exposes internal notes, other bookings or the driver's email. The link is in the request-received email, the approval email and the confirmation page.
- Chat (customer <-> assigned driver only): persisted in `booking_messages`; customer messages go through the private link, driver messages through the signed-in driver session with ownership checked in the query. Quick replies for both roles (the spec's presets) send real messages. Typed messages up to 1,000 characters, text only, 20/min per booking and 30/min per driver rate limits, retry-safe (a re-sent message cannot be stored twice), sending allowed only while the ride is open. A reassigned driver loses the conversation immediately and the new driver sees only their own assignment period. Admin policy: administrators can read conversations on the booking page (read only); the chat tells both sides that Vanta may review messages.
- Driver dashboard: "Chat with customer" and "Call customer / Call passenger" on every open ride.
- **Realtime is polling, not Supabase Realtime**: guests have no Supabase session, and Realtime authorisation needs one, so the chat and status page poll every 4-6 seconds while the tab is visible (and refresh when it becomes visible again). Intervals and listeners are cleaned up on unmount. Switching to Realtime would require giving customers real Supabase accounts, which is the next decision below.
- Tests added (5): chat rules; private-link page and data exposure; end-to-end customer/driver chat with isolation both ways; reassignment; rate limiting. Not tested: real browsers, phones and the dialer; rendering of the new pages (only type-checking and lint were run on components).

## Not done yet (Phase B3 and later)
Customer sign-in account with a "my bookings" list (guests use the private link above); true Supabase Realtime; live (no-refresh) updates on the driver dashboard ride list; email or push alerts for new chat messages; Terms and Privacy pages and admin-editable policies; cleanup-fee settings and ledger; SMS adapter; Supabase RLS policies for direct driver/customer access (today they have none, so direct queries return nothing); audit views and email-retry for the new events beyond the existing Notifications page.
Business decisions still open: cancellation/refund policy, cleanup fee amounts, how existing already-assigned bookings should be released for payment.
