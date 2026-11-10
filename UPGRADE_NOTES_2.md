# Upgrade notes 2: tiers, photos, seats, payments, themes

## About the ZIP you sent
- It contained an **`.env.local`** with values in it. I did not open the values, did not copy the file into the result, and the new ZIP excludes it. If that ZIP was shared anywhere, consider rotating those keys.
- It contained an old, **unused** `src/lib/notify/providers.ts` (Twilio/FormSubmit code that nothing imported). I deleted it so those integrations are not in the project. `src/lib/admin/followups.ts` and its test were also present from an older version; they are harmless and kept.

## 1. What changed
- **Tiers:** "Economical" and "Luxury" become **Business Class** and **First Class** everywhere (seed data, defaults, migration for existing rows). Renaming later (for example to Luxury/Premium) is done in Admin, Categories, Vehicle tiers. Vehicle records, prices and specs were not touched and no vehicle was moved between tiers.
- **Capacity ranges:** category labels now read Vans 11–14, SUVs 6–7, Sedans 2–3, shown on category tiles, fleet cards, vehicle cards and the admin vehicle list. The server separately enforces each vehicle's own maximum passengers (the fare options omit vehicles that do not fit, and a crafted booking above capacity is refused with a 422).
- **Photos:** SVG illustrations are no longer used for vehicles. Vehicle cards, fleet cards and calculator cards use the vehicle photograph, or a branded "Photo coming soon" placeholder when none is assigned. No photos were supplied, so every vehicle currently shows the placeholder until you upload photos.
- **Cloudinary:** Admin, Vehicles, edit a vehicle: preview, upload, replace, remove, see the current photo. Signed, admin-only uploads; type and 8 MB limits; folder `vanta/vehicles`; url and public id saved on the vehicle; unused assets deleted, shared ones protected; clear configuration message when credentials are missing.
- **Fare calculator:** one continuous modal. Trip details on the left; after "Get fares" the right side shows route options, photo vehicle cards (name, tier, capacity, description, price, clear Select control with a visible Selected state), the fare breakdown, the map and the continue buttons. Round trip, stops, hourly, promo code, tolls, region notice and Get a Quote are all kept. Selections carry through to booking.
- **Child seats:** rear-facing, front-facing and booster, with quantities, in the calculator; the fee appears in the fare, the booking summary, the saved booking and the admin booking page. Prices live in Admin, Booking settings ($10 one way, $15 round trip as initial values).
- **Meet & Greet:** the existing implementation from the previous upgrade (airport, airline, flight, terminal, passenger name, requested-vs-confirmed, admin coordination) was audited and kept. Its fee stays **unset** (so nothing is added) until you enter and approve one.
- **Better Quote disclaimer:** one shared wording (FAQ, beside the question in the calculator, directly above the Send button, in the confirmation, on the Get a Quote page, and in the database FAQ migration).
- **Stripe Checkout:** disabled by default; full or deposit (fixed or percent) set in Admin, Booking settings; server-side session creation from the saved total; verified, idempotent webhook; payment states pending, paid, failed, expired, refunded, partially refunded and "review"; retry at `/pay/<private-token>`; payment panel in the admin booking page. Paying never confirms a booking.
- **Themes:** Dark, Light, System (default, follows the OS live), saved in the browser, applied before first paint, toggle in header, footer and admin sidebar. All colours are tokens, including the admin dashboard.
- **Readability:** 16px body text, no text below 14px, larger labels and buttons (44px+ targets), 3px focus rings, errors/successes carry a symbol as well as colour, reduced-motion support, overflow guards.

## 2. Files changed
- added: `src/app/(site)/pay`
- added: `src/app/api/admin/cloudinary`
- added: `src/app/api/payments`
- added: `src/app/api/stripe`
- added: `src/components/PayButton.tsx`
- added: `src/components/ThemeToggle.tsx`
- added: `src/components/VehiclePhoto.tsx`
- added: `src/components/admin/PhotoField.tsx`
- added: `src/lib/child-seats.ts`
- added: `src/lib/cloudinary.ts`
- added: `src/lib/payments-server.ts`
- added: `src/lib/payments.ts`
- added: `src/lib/policy-text.ts`
- added: `src/lib/stripe-signature.ts`
- added: `src/lib/stripe.ts`
- added: `src/lib/theme.ts`
- added: `src/lib/vehicle-photo.ts`
- added: `supabase/migrations/0005_tiers_photos_seats_payments.sql`
- added: `tests/payments-seats.test.ts`
- added: `tests/theme.test.ts`
- removed: `src/lib/notify/providers.ts`
- modified: `.env.example`
- modified: `README.md`
- modified: `next.config.ts`
- modified: `src/app/(site)/book/confirmation/page.tsx`
- modified: `src/app/(site)/page.tsx`
- modified: `src/app/(site)/rides/page.tsx`
- modified: `src/app/admin/(panel)/bookings/[id]/page.tsx`
- modified: `src/app/admin/(panel)/categories/page.tsx`
- modified: `src/app/admin/(panel)/notifications/page.tsx`
- modified: `src/app/admin/(panel)/settings/page.tsx`
- modified: `src/app/admin/admin.css`
- modified: `src/app/api/admin/crud/route.ts`
- modified: `src/app/api/bookings/route.ts`
- modified: `src/app/api/fare/quote/route.ts`
- modified: `src/app/api/quote-requests/route.ts`
- modified: `src/app/globals.css`
- modified: `src/app/layout.tsx`
- modified: `src/components/BookingForm.tsx`
- modified: `src/components/ConfirmationDetails.tsx`
- modified: `src/components/FareCalculator.tsx`
- modified: `src/components/ManualQuoteForm.tsx`
- modified: `src/components/Sections.tsx`
- modified: `src/components/SiteFooter.tsx`
- modified: `src/components/SiteHeader.tsx`
- modified: `src/components/admin/AdminSidebar.tsx`
- modified: `src/components/admin/FieldsForm.tsx`
- modified: `src/data/defaults.ts`
- modified: `src/lib/admin/coerce.ts`
- modified: `src/lib/admin/resources.ts`
- modified: `src/lib/content.ts`
- modified: `src/lib/fare/booking.ts`
- modified: `src/lib/fare/client-types.ts`
- modified: `src/lib/fare/service.ts`
- modified: `src/lib/fare/trip.ts`
- modified: `src/lib/notify/index.ts`
- modified: `src/lib/notify/templates.ts`
- modified: `src/lib/policies.ts`
- modified: `src/lib/types.ts`
- modified: `supabase/seed.sql`
- modified: `tests/integration/fakedb.mjs`
- modified: `tests/workflow.test.ts`

## 3. Migration
Run `supabase/migrations/0005_tiers_photos_seats_payments.sql` (after 0001 to 0004) in the Supabase SQL editor. It is non-destructive: renames tiers and category labels only where they still hold the original seed text, adds `vehicles.image_public_id`, seat and payment settings on `booking_settings`, seat/payment columns and a private `payment_token` on `bookings`, tables `payments` and `stripe_events` (admin-only RLS, no public policies), and updates the two FAQ answers only if unedited. Do not re-run `seed.sql` on an existing database. Not run on a real Postgres here: try it on staging first.

## 4. Environment variables (placeholders in `.env.example`)
`NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `NEXT_PUBLIC_CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (server only), `STRIPE_SECRET_KEY` (server only), `STRIPE_WEBHOOK_SECRET` (server only). Existing variables are unchanged. Cloudinary and Stripe setup, Stripe test cards and the switch to live keys are in README sections 7 and 8. Google Maps key restrictions are unchanged (server key for Routes/Places; browser key restricted by HTTP referrer for Maps JavaScript). On Vercel, add the variables in Project Settings, Environment Variables, then redeploy.

## 5. Manual testing checklist
1. Admin, Booking settings: confirm child seat prices; leave payment `disabled`.
2. Admin, Vehicles: upload a photo for one vehicle; replace it; remove it; confirm the public card and calculator update.
3. Public site: cards show photo or placeholder, tier badge (Business Class / First Class) and capacity ranges; no "Economical" anywhere.
4. Calculator: enter a trip with a stop, add a round trip and 2 child seats; check the seat line ($10 each one way, $15 each once for the whole round trip); pick a vehicle by card; continue to booking; confirm the summary and totals match.
5. Try 5 passengers: vehicles seating fewer are not offered.
6. Request a Better Quote: the disclaimer appears beside the question, above Send, and in the confirmation.
7. Switch Dark, Light, System (and the OS setting); reload; check no flash and readable text on every page, the calculator, booking form and admin.
8. Test mode Stripe: set `full`, create a booking, pay with 4242 4242 4242 4242, confirm the status changes only after the webhook; cancel a payment and retry; resend a webhook event and confirm nothing doubles.
9. Zoom to 200% and check a phone width: no horizontal scrolling.

## 6. Verification results
- `npm test`: **73 passed, 0 failed** (previous 48 plus new tests for seats, capacity, tiers, disclaimer, Cloudinary authorization and persistence, Stripe amounts, signature verification, duplicate webhooks, retries, refunds, theme persistence and contrast).
- `npm run lint` and `npm run build`: **not run**. This environment has no network, so `next`, ESLint and the type packages cannot be installed. Run them locally first and fix anything they report.
- Best-effort `tsc` without the project's type packages: only the same three errors the original project already produced; none in new code. This is not a substitute for the real build.
- **Not verified:** live Stripe and Cloudinary, the migration on a real database, the app running in a browser (layouts at phone/tablet widths, theme flash, screen readers). The contrast test checks the token pairs used for text, borders and focus in both themes; it cannot catch every combination in every component.

## 7. Decisions still needed from the client
- **Capacity mismatch:** the stored vehicles seat up to 8 (SUVs) and 4 (sedans), but you asked for ranges of 6–7 and 2–3. I did not change vehicle specifications. Customers see your ranges; the server allows up to each vehicle's real maximum. If 7 and 3 are the true maximums, lower "Maximum passengers" on those vehicles in Admin.
- The project has **two sedan categories** (full-size and mid-size) rather than one. Both now show 2–3 passengers.
- **Child seats:** the fee is per seat; the round-trip rate is charged once per seat for the whole round trip. Please approve or adjust.
- **Deposits:** a deposit leaves a balance that is collected outside the website (the pay page does not take a second payment). Please decide the deposit amount/percent and any payment, cancellation or refund wording (Admin, Booking settings, Payment terms).
- **Meet & Greet fee:** still unset.
- A payment is calculated from the booking's saved total. If staff edit a booking's estimated fare, the new amount is what the customer is asked to pay.

## 8. Files in this change
(see section 2)
