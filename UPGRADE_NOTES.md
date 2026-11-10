# Vanta Transportation upgrade notes

This upgrade was applied to the existing Next.js / Supabase project. Nothing was rebuilt from scratch.

## 1. What was implemented
- **Family-focused site:** new hero copy and CTAs (BOOK A RIDE / GET A QUOTE), a "rides for the people you care about" section, three-tier coverage section, "What to expect" policies section, updated header/footer/floating buttons. No reviews, certifications, safety guarantees or background-check claims were added. Hero text, phone, email, hours, coverage and policy wording are editable under **Admin, Website content**.
- **Business details:** phone +1 443-910-1794 (clickable), email vantaholdings.1@gmail.com (clickable), hours 24/7 with the availability clarification.
- **Coverage:** DMV / East Coast (NC to NY) / other US and Europe, with a note that Vanta does not own a fleet everywhere. Out-of-area trips are never rejected: they are saved for manual review or a quote. Staff see the service region and a fulfilment indicator (Vanta / partner / needs review) on the booking and quote pages.
- **Get a Quote** page (`/quote`) for custom prices and unusual or out-of-area trips; the existing "Request a Better Quote" flow is kept, including original estimate, quote history, customer accept/decline and conversion.
- **Round trips:** return date/time/route; each leg priced by the existing engine; discount comes only from admin-created rules (**Admin, Round-trip rules**); both legs, discount and total are shown; legs and pricing snapshots are stored; totals are recalculated on the server.
- **Booking for someone else:** separate booker and passenger records (`booking_people`), luggage, assistance and pickup instructions.
- **Emergency / secondary contacts** (up to two), stored separately, shown only in the admin booking view, never placed in emails or alerts.
- **Airport details and Meet & Greet:** saved per booking; shown as *requested* until staff mark it *confirmed*. Its charge stays "to be confirmed" until an admin enters and approves one in **Booking settings**.
- **Policies:** waiting-time and no-show wording shown before submitting, with a required "I have read" checkbox; the wording in force is stored with the booking.
- **Admin:** booking detail now shows region, fulfilment, legs, booker/passenger, contacts, airport/Meet & Greet, waiting and no-show records, plus an Operations panel (fulfilment/partner, Meet & Greet status, waiting time, Mark as no-show with reason, staff, charge and payment status). These record data only; nothing charges a payment method.
- **Brevo email** replaces FormSubmit; **Twilio/SMS removed**; **native browser notifications** plus an in-dashboard alert list (see below).

## 2. Modified files
- added: `src/app/(site)/quote/page.tsx`
- added: `src/app/api/admin/bookings`
- added: `src/app/api/admin/notifications/feed`
- added: `src/app/api/admin/notifications/read`
- added: `src/components/ManualQuoteForm.tsx`
- added: `src/components/admin/BookingOps.tsx`
- added: `src/components/admin/NotificationCenter.tsx`
- added: `src/lib/booking-details.ts`
- added: `src/lib/coverage.ts`
- added: `src/lib/notify/brevo.ts`
- added: `src/lib/policies.ts`
- added: `src/lib/pricing/roundtrip.ts`
- added: `supabase/migrations/0004_family_upgrade.sql`
- removed: `src/lib/notify/providers.ts`
- modified: `.env.example`
- modified: `README.md`
- modified: `src/app/(site)/book/confirmation/page.tsx`
- modified: `src/app/(site)/book/page.tsx`
- modified: `src/app/(site)/page.tsx`
- modified: `src/app/admin/(panel)/[resource]/page.tsx`
- modified: `src/app/admin/(panel)/bookings/[id]/page.tsx`
- modified: `src/app/admin/(panel)/notifications/page.tsx`
- modified: `src/app/admin/(panel)/quotes/[id]/page.tsx`
- modified: `src/app/admin/(panel)/settings/page.tsx`
- modified: `src/app/admin/admin.css`
- modified: `src/app/api/admin/crud/route.ts`
- modified: `src/app/api/admin/quotes/convert/route.ts`
- modified: `src/app/api/admin/quotes/send/route.ts`
- modified: `src/app/api/bookings/route.ts`
- modified: `src/app/api/fare/quote/route.ts`
- modified: `src/app/api/quote-requests/route.ts`
- modified: `src/app/globals.css`
- modified: `src/components/BookingForm.tsx`
- modified: `src/components/FareCalculator.tsx`
- modified: `src/components/FloatingActions.tsx`
- modified: `src/components/Sections.tsx`
- modified: `src/components/SiteFooter.tsx`
- modified: `src/components/SiteHeader.tsx`
- modified: `src/components/admin/AdminSidebar.tsx`
- modified: `src/components/admin/QuoteActions.tsx`
- modified: `src/components/admin/ResourceManager.tsx`
- modified: `src/data/defaults.ts`
- modified: `src/lib/admin/resources.ts`
- modified: `src/lib/config.ts`
- modified: `src/lib/fare/booking.ts`
- modified: `src/lib/fare/client-types.ts`
- modified: `src/lib/fare/service.ts`
- modified: `src/lib/fare/trip.ts`
- modified: `src/lib/notify/index.ts`
- modified: `src/lib/notify/templates.ts`
- modified: `supabase/seed.sql`
- modified: `tests/helpers.test.ts`
- modified: `tests/integration/fakedb.mjs`
- modified: `tests/workflow.test.ts`

## 3. SQL migration
Run `supabase/migrations/0004_family_upgrade.sql` in the Supabase SQL editor after 0001 to 0003. It adds columns to `bookings` and `quote_requests`; new tables `booking_legs`, `booking_people`, `booking_airport_details`, `booking_settings`, `round_trip_rules`, `admin_notifications`, `admin_notification_reads`; admin-only Row Level Security on every new table (no public policies); adds the `no_show` status; and adds policy/coverage/contact content (only overwriting content an admin has not edited). Existing bookings, prices and customers are untouched. The `sms` value is kept in `notification_logs.channel` so historical SMS rows stay valid. **Not run on a real Postgres in this environment**; apply it to a staging project first.

## 4. Environment variables
See `.env.example` (placeholders only): `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`, `BUSINESS_NOTIFICATION_EMAIL`, plus the existing Supabase, site and Google variables. Removed: all `FORMSUBMIT_*`, `TWILIO_*`, `SMS_PROVIDER`, `BUSINESS_NOTIFICATION_PHONE`.

## 5. Brevo setup
See README section 4. In short: create an API key, verify a sender or domain in Brevo, set the four variables, submit a test booking, and confirm `sent` rows in Admin, Notifications **and** that the mail arrived. If the key or sender is missing, emails are `skipped`, bookings are still saved, and the dashboard shows a configuration warning. Delivery has **not** been tested against Brevo.

## 6. Browser notifications
Admin, sidebar, **Alerts, Enable browser notifications**. Permission is requested only on that click. Denied/unsupported browsers keep the in-dashboard list and unread badge.

**Notifications work only while an admin dashboard tab is open.** They do not work with the browser closed; Web Push (service worker, VAPID keys, subscription storage, push sender) was deliberately not added. Detection is an authenticated poll every 30 seconds while the tab is visible, not a public Realtime subscription, because this project's admin uses server-side cookie sessions.

## 7. Removed integrations
Active Twilio and FormSubmit code, UI, settings, env variables and docs were removed (`src/lib/notify/providers.ts` deleted; no SDK dependency existed). A repo-wide search finds only historical notes (migrations 0001 to 0003, a README line saying there is no SMS, and a code comment about historical rows).

## 8. Awaiting business approval (nothing here was invented)
- Airport Meet & Greet charge (and whether it is offered).
- Round-trip discount amount/percent, which vehicle categories qualify (no rule is active by default).
- Waiting-time rate per 15-minute increment (the 15 included minutes and 15-minute increments are configurable defaults).
- No-show charge handling and any cancellation deadlines, fees or refund terms (none are published).
- Whether promo codes may combine with a round-trip discount (currently they do not; the round-trip rule wins).
- Whether East Coast and other trips are fulfilled by Vanta or named partners (staff decide per booking).

## 9. Test results
- `npm test`: **47 passed, 0 failed** (node test runner, in-memory database, mocked Google and Brevo).
- `npm run lint` and `npm run build`: **could not be run** here: the sandbox has no network, so dependencies (`next`, `eslint`, `@types/*`) cannot be installed. Run them locally first.
- Best-effort `tsc` without the project's type packages shows only the same missing-types noise as the original project; no errors specific to the new code. This is not a substitute for a real build.
- Not tested: live Brevo, Supabase RLS/migration on a real database, Google APIs, real browser notification permission flows, and visual checks at tablet/mobile widths.

## 10. Local install and testing
```
npm install
cp .env.example .env.local     # fill in values
# run supabase/migrations/0001..0004 and seed.sql in Supabase
npm test && npm run lint && npm run build
npm run dev
```

## 11. Intentionally out of scope
Native customer/driver apps, live GPS tracking, automated dispatch, a full affiliate marketplace, fleet telematics, corporate billing, automated charging of waiting/no-show fees, closed-browser Web Push, and emergency-response monitoring. None of these is advertised as available.
