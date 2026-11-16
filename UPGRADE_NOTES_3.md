# Upgrade notes 3: fixed tier pricing, per-tier Meet & Greet, Stripe + PayPal, navbar

**Note on the request:** the prompt text ended mid-sentence in the testing section ("The option appears during Calculate Y…"). I implemented and tested every requirement above that point; if the cut-off part contained further acceptance criteria, please send them.

## 1. What changed
- **Exactly three tiers: Premium, Luxury, Luxury Plus.** The migration renames the existing tier rows in place (lowest tier to Premium, middle to Luxury; a legacy "Super Luxury" would become Luxury Plus), adds Luxury Plus, and deactivates (does not delete) any other tier. Vehicle assignments and bookings keep pointing at the same rows, so nothing is reassigned. No vehicle is assigned to Luxury Plus automatically: assign vehicles in Admin, Vehicles. "Economical", "Economy", "Super Luxury", "Business Class" and "First Class" no longer appear in active code or seed data (a test enforces this).
- **Admin fixed prices.** Admin, **Tier prices & fees**: fixed price and Meet & Greet fee per tier. Validated (above $0 and at most $10,000, or blank), admin-only, names fixed, tiers cannot be created or deleted. **No fixed price is pre-filled**; a setup warning shows until all three are entered, and online payment stays unavailable for a tier without one.
- **Calculated estimate vs amount charged.** The trip estimate (mileage, hours, duration, tolls, round-trip discount) is unchanged and still shown, labelled "information only". The online charge is separate: **fixed tier price + Meet & Greet (if ticked) + child seats (if requested)**, and never includes trip-based amounts. The calculator, booking summary, pay page, emails and admin all show the two separately ("Estimated trip fare" vs "Charged online").
- **Meet & Greet in Calculate Your Fare.** A checkbox "Airport Meet & Greet — Optional paid service" with the fee of the selected vehicle's tier (initial fees: $25 / $35 / $50, seeded and editable). It follows the tier when the vehicle changes, disappears from the total when unticked, is shown as its own line, is never free and never added twice. The old single Meet & Greet charge setting was consolidated into the per-tier fees. Airport details are required by the booking form when it is ticked.
- **Stripe + PayPal on one payment model.** Card payments (Stripe Checkout) and PayPal (official JS SDK; orders created and captured on the server, amount/currency/order/booking verified) write to the same `payments` table with provider, provider references, the fixed price, Meet & Greet and add-on amounts, tier name, the (informational) trip estimate, status and timestamps. Webhooks are verified (Stripe signature; PayPal verification API) and processed once per event id. A booking is never marked paid from a success URL or a browser callback, and a payment never confirms a booking.
- **Admin.** New **Payments** page (provider status without secrets, every payment, amount collected) and a pricing/payment panel on each booking.
- **Navbar.** Theme controls collapsed into a compact "Theme" dropdown, clearer grouping and spacing, BOOK A RIDE kept prominent, Home reachable from the logo and the mobile menu, keyboard-accessible dropdown (Escape, outside click, arrow key) and a mobile menu with focus moved in, focus kept inside, Escape to close and focus returned. All original destinations are kept.

## 2. Files changed
- added: `src/app/admin/(panel)/payments`
- added: `src/app/api/payments/paypal`
- added: `src/app/api/paypal`
- added: `src/components/PaymentChoice.tsx`
- added: `src/components/admin/TierStatus.tsx`
- added: `src/lib/payment-providers.ts`
- added: `src/lib/paypal-verify.ts`
- added: `src/lib/paypal.ts`
- added: `src/lib/tier-pricing.ts`
- added: `supabase/migrations/0006_fixed_tier_pricing_paypal.sql`
- added: `tests/tier-paypal.test.ts`
- removed: `src/components/PayButton.tsx`
- modified: `.env.example`
- modified: `README.md`
- modified: `src/app/(site)/pay/[token]/page.tsx`
- modified: `src/app/admin/(panel)/[resource]/page.tsx`
- modified: `src/app/admin/(panel)/bookings/[id]/page.tsx`
- modified: `src/app/admin/(panel)/categories/page.tsx`
- modified: `src/app/api/admin/bookings/ops/route.ts`
- modified: `src/app/api/admin/crud/route.ts`
- modified: `src/app/api/bookings/route.ts`
- modified: `src/app/api/fare/quote/route.ts`
- modified: `src/app/api/payments/checkout/route.ts`
- modified: `src/app/api/quote-requests/route.ts`
- modified: `src/app/globals.css`
- modified: `src/components/BookingForm.tsx`
- modified: `src/components/ConfirmationDetails.tsx`
- modified: `src/components/FareCalculator.tsx`
- modified: `src/components/Sections.tsx`
- modified: `src/components/SiteHeader.tsx`
- modified: `src/components/admin/AdminSidebar.tsx`
- modified: `src/components/admin/BookingOps.tsx`
- modified: `src/data/defaults.ts`
- modified: `src/lib/admin/data.ts`
- modified: `src/lib/admin/resources.ts`
- modified: `src/lib/fare/booking.ts`
- modified: `src/lib/fare/client-types.ts`
- modified: `src/lib/fare/service.ts`
- modified: `src/lib/fare/trip.ts`
- modified: `src/lib/notify/templates.ts`
- modified: `src/lib/payments-server.ts`
- modified: `src/lib/payments.ts`
- modified: `src/lib/policies.ts`
- modified: `src/lib/stripe.ts`
- modified: `supabase/seed.sql`
- modified: `tests/integration/fakedb.mjs`
- modified: `tests/payments-seats.test.ts`
- modified: `tests/workflow.test.ts`

## 3. Migrations (run in order)
`0001` to `0005` (already applied), then **`0006_fixed_tier_pricing_paypal.sql`**. It is idempotent and non-destructive: tier columns and snapshot columns on bookings, shared payment columns, `paypal_events`, provider switches. Not run on a real Postgres here: apply to staging first. Do not re-run `seed.sql` on an existing database.

## 4. Environment variables (placeholders in `.env.example`)
Existing ones unchanged. Payments: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV` (sandbox or live), `PAYPAL_WEBHOOK_ID`. Hosted Stripe Checkout needs no publishable key, so none is read. None is exposed through `NEXT_PUBLIC_`. Setup steps for Stripe test keys and webhooks (local and production), PayPal sandbox and live, the platform environment, the migrations, and entering the tier prices are in README section 8.

## 5. Testing before launch
1. Apply migration 0006 on staging; open Admin, Tier prices & fees and enter the three fixed prices; assign vehicles to tiers.
2. Booking settings: set Online payment to `full`, leave both providers on.
3. Calculator: pick a vehicle, tick Meet & Greet, add a child seat; check the two blocks (Charged online / Estimated trip fare), then change vehicle tier and untick Meet & Greet and watch the fee follow.
4. Submit the booking, open the pay link, pay with a Stripe test card, then with a PayPal sandbox buyer; confirm Admin, Payments shows the right provider, tier, components and total, and that the booking is not auto-confirmed.
5. Resend a webhook event and refresh the pay page: nothing should double. Cancel a payment and retry.
6. Check the navbar at phone, tablet and desktop widths with keyboard only (Tab, Enter, Escape).

## 6. Test results
- `npm test`: **81 passed, 0 failed** (previous 73, updated for the new model, plus new tests for the three tiers, per-tier Meet & Greet, fixed-price snapshots, admin authorization and validation, tamper resistance, Stripe line items, the full PayPal create/capture/webhook/refund/retry flow with PayPal's API mocked, money conversion, wording and navbar behaviour).
- `npm run lint` and `npm run build`: **not run** (no network here, so `next` and ESLint cannot be installed). Run them first.
- Best-effort `tsc` without the project's type packages: no errors in new code beyond the three the original project already produced.
- **Not verified:** live Stripe and PayPal (sandbox or live), the migration on a real database, and the navbar and calculator in a real browser (layout, focus behaviour, screen readers).

## 7. Decisions I made that the business should confirm
- **Round trips:** the fixed tier price is charged **once per booking**, not per leg. Please confirm.
- **Child seats:** treated as an explicit paid add-on and **included in the online charge** (their $10 / $15 per seat rates were defined earlier by the business); they are no longer part of the trip estimate. Remove or adjust if you do not want them charged online.
- **Price lock:** the tier price and fees a customer is shown are frozen when they submit the booking and are what they are charged, even if an admin changes prices before they pay. New bookings use the new prices.
- **Deposits** (if you choose that mode) are a fixed amount or percent of the online amount, not of the trip estimate.
- **Quote conversions** at an agreed custom price carry no online charge (staff handle payment), because that price is not a tier fixed price.
- **The excluded trip charges:** I wrote no policy for how mileage/hourly amounts are collected; the screens only say the estimate is for information and not part of the online amount. Decide and add the wording you want (Admin, Booking settings, Payment terms).
- Online payment itself stays **disabled** until an admin switches it on; a provider is offered only when switched on and configured.
