# Vanta Transportation: chauffeur website, fare calculator, CRM and admin dashboard

Next.js 16 (App Router), React 19, Tailwind 4, TypeScript, Supabase. One project containing the public website, the Google-Maps fare calculator, the booking and quote workflows, the CRM and the admin dashboard.

## What is included

**Public site:** Home, About us, Rides we offer, Contact, Request a booking (`/book`), booking confirmation, and a private customer page for revised quotes (`/quote/<token>`). Black / charcoal / graphite / silver design built around the supplied logo.

**Fare calculator** (floating button, header, hero): pickup, destination, multiple stops, date/time, trip type (point to point or hourly), passengers, promo code. Address suggestions (Google Places), real road distance and drive time (Google Routes API, never straight-line), route drawn on a map, fastest-route vs no-toll options with the price difference, and per-vehicle fares with an itemized breakdown. If Google does not return a toll price, the quote says so and adds nothing.

**Pricing engine** (`src/lib/pricing/engine.ts`): per-vehicle per-mile, hourly, minimum fare, base fare, long-trip rate, hourly mileage allowance with a separate extra-mile rate, surcharges, tolls, approved discounts. Integer-cent maths. Fares are always recalculated on the server from the database configuration; browser-supplied prices are ignored. Each booking stores a frozen price snapshot.

**Booking flow:** calculator details carry into `/book` without re-entry. The server revalidates, recalculates the fare, saves the customer (matched by email/phone), booking, stops and snapshot, returns a reference (`VT-1001`...), then sends notifications. The booking is kept even if every notification fails.

**Request a Better Quote:** customers submit name, contact, desired budget and a message with their trip attached. Admins review, add notes, set a discount decision and revised price, send it (the private link is emailed to the customer through Brevo and shown to the admin), the customer accepts or declines on that link, and an accepted quote converts to a booking at the agreed price. Nothing is auto-approved.

**Notifications:** central service with logs, duplicate protection (unique key per event), retry from the dashboard, and configuration warnings. Email is sent through the Brevo transactional API. Admins also get in-dashboard alerts and optional native browser notifications (active admin tab only). There is no SMS.

**Admin dashboard** (`/admin`): Overview (live stats), Bookings, Customers (history, notes, follow-ups), CRM / Leads, Quote requests, Follow-ups, Vehicles (images, capacity, availability), Vehicle categories and tiers (create, rename, reorder, deactivate), Pricing management (configurations, surcharges, promo codes), FAQs, Promotions (popup), Website content, Vehicle standards, Notifications, Settings.

**Also:** floating FAQ chat powered by Supabase FAQs, promotional popup with frequency/date/mobile controls, honeypots, rate limiting, same-origin checks, RLS on every table.

## Setup

```bash
npm install
cp .env.example .env.local     # fill in values (see below)
npm run dev                    # http://localhost:3000
npm test                       # 38 tests (pricing engine, helpers, end-to-end workflows on an in-memory DB)
npm run lint
npm run build && npm start
```

Requires Node 22 or newer (the tests use built-in TypeScript stripping).

### 1. Supabase
1. Create a project at supabase.com.
2. SQL editor: run in order `supabase/migrations/0001_schema.sql`, `0002_rls.sql`, `0003_workflows.sql`, `0004_family_upgrade.sql`, `0005_tiers_photos_seats_payments.sql`, `0006_fixed_tier_pricing_paypal.sql`, then (fresh installs only) `supabase/seed.sql`. On an existing database run only the migrations you have not run yet; do NOT re-run the seed.
3. Project Settings, API: copy the URL, publishable (anon) key and service-role key into `.env.local`.
4. Authentication, Providers, Email: **turn off "Allow new users to sign up"** (there is no public registration; even if someone signed up, they would have no data access because every table is admin-only).
5. Storage: the `site-images` bucket is created by migration 0002 (public read, admin write).

**Security model:** the public (anon) role can only read published content (active vehicles, categories, tiers, FAQs, standards, live promotions, non-settings site content). Pricing, customers, bookings, quotes, notes and logs are readable only by users in `admin_users`. There are no public INSERT policies: public forms post to server routes that validate input and write with the service-role key, which never reaches the browser.

### 2. Admin account
1. Supabase, Authentication, Users, Add user (email + password, tick auto-confirm).
2. SQL editor:
```sql
insert into public.admin_users (user_id, email)
select id, email from auth.users where email = 'you@example.com';
```
3. Sign in at `/admin/login`. Sessions use HttpOnly cookies, are re-validated against Supabase and `admin_users` on every request, and every admin API checks the same-origin header.

**Sign-in messages (each failure now reports its own cause):**
| Message | Meaning / fix |
|---|---|
| Incorrect email or password | Supabase rejected the credentials (also shown for an unknown email). Reset the password in Authentication, Users. |
| Your password is correct, but this account is not authorized as an administrator | Login worked but there is no matching row in `admin_users`. Run the SQL above. If it reports `INSERT 0 0`, the email in `auth.users` did not match; check with `select id, email from auth.users;`. |
| Email address has not been confirmed | Tick/confirm the user in Authentication, Users. |
| Server configuration error / Database error while checking administrator access | `SUPABASE_SERVICE_ROLE_KEY` is missing, wrong, or is the anon key. Details are in the server log. |
| Database is not set up: admin_users table is missing | Run the migrations in order. |
| Sign-in service error | Check `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` (details in the server log). |

### 3. Google Maps
Create a Google Cloud project with billing enabled and two keys:
- **Server key** (`GOOGLE_MAPS_SERVER_API_KEY`): enable **Routes API** and **Places API (New)**. Restrict by API (and by IP if your host has fixed egress IPs).
- **Browser key** (`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`): enable **Maps JavaScript API** (and **Maps Embed API** for the contact-page map). Restrict by HTTP referrer to your domain.

Google bills per request (route calculation with toll data is a higher-priced tier). Check current pricing. Without the server key the calculator shows a clear message and sends customers to the contact form; without the browser key routes still calculate but the map is replaced by a notice.

### 4. Email (Brevo)
Emails are sent server-side through `https://api.brevo.com/v3/smtp/email` (`src/lib/notify/brevo.ts`).
1. Create a Brevo account and an API key (SMTP & API, API keys).
2. In Brevo, **verify a sender** (a single email address, or better, authenticate your sending domain with the DKIM/DMARC records Brevo shows). Brevo rejects mail from unverified senders. Do not assume the business Gmail address is verified.
3. Set `BREVO_API_KEY`, `BREVO_SENDER_EMAIL` (the verified sender), `BREVO_SENDER_NAME`, and `BUSINESS_NOTIFICATION_EMAIL` (defaults to vantaholdings.1@gmail.com).
4. Submit a test booking and check **Admin, Notifications**: rows show `sent`, `failed` (with Brevo's reason, retryable) or `skipped` (not configured). Until you have seen `sent` rows and received the mail, do not assume delivery works.
Duplicate protection: every email has a unique dedupe key stored before sending, so a repeated event cannot send twice (Brevo's API has no idempotency header, so this is done in the database). Bookings and inquiries are saved first; an email failure never removes them.

### 5. Browser notifications (admin)
Admins open the dashboard and use **Alerts, Enable browser notifications** (an explicit click; the permission prompt is never shown automatically). Alerts come from the `admin_notifications` table, written only after a booking, inquiry or quote request is saved, and are polled by the dashboard every 30 seconds while the tab is visible. Notification text contains only a reference and a generic message, never names, phones, addresses or emergency contacts. Clicking one opens the record.
**Limitation:** they work only while an admin dashboard tab is open in the browser (a background tab is fine; a closed browser is not, and some browsers throttle background timers). Reliable closed-browser notifications need Web Push (service worker, subscription storage, VAPID keys and a push sender), which is **not implemented**. Without permission (denied or unsupported) the Alerts list and unread badge still work.


### 7. Vehicle photos (Cloudinary)
1. Create a Cloudinary account. From the Dashboard copy the **cloud name**, **API key** and **API secret**.
2. Set `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `NEXT_PUBLIC_CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` (secret = server only; on Vercel add them under Project Settings, Environment Variables, and redeploy).
3. In **Admin, Vehicles**, edit a vehicle: *Vehicle photo* lets you choose a JPG/PNG/WebP (max 8 MB), preview it, upload it, replace it or remove it, then **Save**. Photos go to the `vanta/vehicles` folder; the URL and public id are stored on the vehicle row and appear on vehicle cards and in the fare calculator immediately.
4. Security: only signed-in admins can request an upload signature (`/api/admin/cloudinary/sign`); the secret never reaches the browser; there is no unsigned public upload; only images inside your own cloud and the `vanta/vehicles` folder can be assigned; a replaced or removed image is deleted from Cloudinary only if no other vehicle uses it. An upload that is never saved can remain in Cloudinary (you can delete it in the Cloudinary console).
5. Without credentials the admin shows a configuration message and the public site shows a branded "Photo coming soon" placeholder. No photos are included in this project: upload your own licensed photos.

### 8. Tier prices, Meet & Greet fees and online payments
**The three tiers.** Customers choose a vehicle, and every vehicle belongs to one of exactly three tiers: **Premium, Luxury, Luxury Plus**. In **Admin, Tier prices & fees** set, for each tier:
- the **fixed price** charged online (no price is pre-filled: you must enter all three; until a tier has one, customers cannot pay online for vehicles in it), and
- the **Meet & Greet fee** (initial values from the business: Premium $25, Luxury $35, Luxury Plus $50).
Tier names are fixed; vehicles are assigned to tiers under **Admin, Vehicles** (nothing is reassigned automatically, and no vehicle is assigned to Luxury Plus until you assign one).

**What is charged online.** Only: fixed price of the selected tier + Meet & Greet fee (if ticked) + child seats (if requested). The mileage/hourly/duration/toll **trip estimate is still calculated and shown, but it is information only and is never part of the online charge.** Example (illustrative only): a $150 fixed price plus a $35 Meet & Greet fee is a $185 online amount. The prices a customer is shown are frozen on the booking when they submit it, so later admin changes never rewrite saved bookings or payments.

**Switching payments on.** In **Admin, Booking settings** set *Online payment* (`disabled` by default; `full` charges the online amount; the deposit modes take a fixed amount or a percent of the online amount) and choose which providers to offer. A provider is shown to customers only if it is switched on there AND configured on the server. **Admin, Payments** shows provider status (no secrets) and every payment.

**Stripe (cards).** Uses Stripe-hosted Checkout (Visa, Mastercard and American Express where your Stripe account supports them; card data never touches this application).
1. Test mode: put the secret key in `STRIPE_SECRET_KEY`.
2. Create a webhook endpoint `https://YOUR-DOMAIN/api/stripe/webhook` for: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`; put its signing secret in `STRIPE_WEBHOOK_SECRET`. Locally: `stripe listen --forward-to localhost:3000/api/stripe/webhook` prints a temporary `whsec_...`.
3. Test card 4242 4242 4242 4242 (any future date, any CVC); American Express test card 3782 822463 10005.
4. Live: create live keys and a live webhook endpoint, replace the two variables, redeploy, and run one small real payment.

**PayPal.**
1. At developer.paypal.com create a **Sandbox** app; set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_ENV=sandbox`.
2. In the app, add a webhook `https://YOUR-DOMAIN/api/paypal/webhook` for `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.REFUNDED`; set its id as `PAYPAL_WEBHOOK_ID`.
3. Pay with a sandbox buyer account.
4. Going live: create a **Live** app, replace the three variables with the live credentials, set `PAYPAL_ENV=live`, create the live webhook, redeploy.
The customer approves in PayPal's pop-up; the server then captures the order and verifies amount, currency, order and booking before anything is marked paid. The webhook handles delayed completions and refunds.

**Safety rules built in.** Amounts are calculated on the server from the database (the browser only sends the private booking token and the provider); a success page or button callback never marks anything paid; webhooks are verified (Stripe signature / PayPal's verification API) and processed once per event id; duplicate payments and emails are prevented; failed or expired payments keep the booking and offer a retry at `/pay/<private-token>`; a payment never confirms a booking.

### 9. Themes and accessibility
Dark, Light and System (default) are chosen with the toggle in the header, footer and admin sidebar; the choice is saved in the browser and applied before first paint. Colours are CSS variables in `src/app/globals.css`. `npm test` checks WCAG AA contrast (4.5:1 text, 3:1 borders/focus) for both themes. See UPGRADE_NOTES_2.md for what was and was not verified.

### 6. Deployment
Deploy to Vercel (or any Node host): import the repo, add every variable from `.env.example` in the host's settings, set `NEXT_PUBLIC_SITE_URL` to the live URL, deploy. Never commit `.env.local`.

## Pricing: read before publishing
- All seeded prices are **unconfirmed draft** research (the second client table: per-mile, hourly, minimum). They are stored as `draft`; customers cannot get online quotes until you set a configuration to **Active** in Pricing management. Activating archives that vehicle's previous active configuration. The client's proposed reductions are not applied; edit the numbers yourself.
- Hourly bookings include `hourly_included_miles` (seeded at 20) **per booking** by default; change "Included miles apply" to *per hour* if intended. The **extra-mile rate is a separate field**; it is seeded equal to the per-mile rate as a placeholder, so confirm it.
- Vehicles with no active pricing can still be requested; they show "Price on request" and no price is invented.
- Promo codes you create under Pricing management count as approved discounts; negotiated discounts are handled per quote request.

## Project layout
```
src/app/(site)/         public pages, /book, /quote/[token]
src/app/admin/          login and the dashboard ((panel) = protected pages)
src/app/api/            contact, fare/quote, bookings, quote-requests, places, admin/*
src/components/         public components; admin/ holds dashboard components
src/lib/pricing/        pricing engine (pure)
src/lib/fare/           trip validation, fleet + pricing loading, booking creation
src/lib/geo/            Google Routes/Places clients, route parsing, time zones
src/lib/notify/         Brevo client, email templates, logging, retry, admin alerts
src/lib/coverage.ts     service-region classification (DMV / East Coast / other)
src/lib/policies.ts     booking settings, policy text, round-trip rules loader
src/lib/admin/          auth, resource definitions, validation (the write whitelist)
supabase/               migrations and seed
tests/                  unit tests and end-to-end workflow tests with an in-memory DB
```

## Testing status (honest summary)
**Run and passing in the build environment:** 81 automated tests (`npm test`): pricing engine, helpers, coverage classification, round-trip and waiting math, booking-detail validation, and end-to-end route tests against an in-memory database with mocked Google and Brevo responses (round trips, booking for someone else, contacts, Meet & Greet, out-of-area quotes, no-show/waiting actions, notification feed, email failure/retry/dedupe). These do not prove live integrations work.
A best-effort `tsc` run without the project's type packages reports only the same missing-types noise as the original project and no errors specific to the new code.

**Not verified (the build environment had no network access):** live Stripe, live PayPal, live Cloudinary uploads, `npm install`, `next lint`, `next build`, the real `@types`-based type check, the SQL migrations on a real Postgres, live Supabase Auth/RLS/Storage, and every live integration (Google Maps/Routes/Places, Brevo delivery, browser notifications in real browsers), plus visual testing of the full app at tablet/mobile widths (the design system was previewed in a browser using static markup only). Run `npm run build` and `npm run lint` first; the first live bookings and notifications should be treated as the integration test.

## Notes and assumptions
- Pickup times are interpreted in `BUSINESS_TIMEZONE` (default America/New_York; change if needed).
- Vehicle images are original SVG placeholders; upload real photos under Vehicles.
- Content flagged "placeholder" in Website content is sample copy. No company history, awards, licenses or testimonials were invented.
- The "Driver Trip Process" PDF was not provided to the build and is not used on the public site. No driver portal was built; bookings have an `assigned` status and the schema leaves room to add drivers later.
- The in-memory rate limiter is per server instance; add a WAF/edge rule or a shared store for production-grade limits.
- SIXT was a layout/experience reference only; no SIXT assets or code are used.
