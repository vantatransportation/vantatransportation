# Saved-card booking workflow (replaces the payment-link / card-hold workflow)

**Flow:** save the card at booking (Stripe SetupIntent: **no charge, no hold**) -> booking waits for admin approval -> admin approves (**charges nothing, confirms nothing, assigns no driver**) -> customer reviews the total and presses **Confirm Booking & Authorize Charge** -> the saved card is charged once -> after Stripe's *verified* result the booking becomes **Confirmed** and **paid** -> only then can the admin assign a driver.

No payment-link email exists at any stage. Approval emails send the customer to their own booking/tracker page.

## 1. Root cause of the old behaviour
* `POST /api/bookings` only saved a request. Card details were never collected in the booking flow; at most a hosted Stripe Checkout "authorize now" hold was offered (switch `stripe_authorize_at_booking`, default OFF), otherwise the confirmation page said *"No card is held. If we approve your booking we will email you a secure payment link"*.
* Admin approval was one combined action (`approve_assign`) that assigned a driver, set `payment_released_at` and either captured the hold or triggered the emailed link (`booking.approved` template with `_payUrl`, `startCheckout` -> hosted Stripe Checkout).
* Driver assignment therefore happened **before** payment, and payment was something the customer did later by link.

## 2. Customer journey now
1. Customer calculates the fare, fills in the form, presses the existing **Send booking request** button. The booking is saved (same duplicate protection: `submissionKey`).
2. They land immediately on `/book/confirmation?t=<private token>` which shows the **card step** (Stripe Payment Element) with the consent wording and the total. The card is saved with a SetupIntent. Nothing is charged, nothing is held. A refresh, a double click or a second tab reuses the same booking and the same SetupIntent.
3. The server verifies the SetupIntent with Stripe, stores only Stripe ids + card brand/last4, records the consent text, and *then* tells the business ("new booking request") and the customer ("request received, nothing charged"). Status shown: **Booking Request Received: Awaiting Admin Approval**, with the tracking number as a clickable link to the individual ride tracker.
4. Admin approves (button **Approve booking**; blocked while the card step is unfinished). Customer gets an email with a link to their booking page/tracker, and the same action is visible on the website itself (email is never required).
5. Customer sees the approved booking and total and presses **Confirm Booking & Authorize Charge** (consent checkbox). Server checks approval, consent, saved card, authoritative total, then charges the saved card once. If the bank needs authentication (3-D Secure) the page completes it with Stripe (`handleNextAction`); a decline shows a clear message with retry or "use a different card".
6. Only Stripe's verified result (API reply re-read from Stripe, or signature-verified webhook) calls `recordPaid()`, which marks the payment paid, sets `confirmed_at`/status Confirmed and sends the confirmation email. The admin can now assign a driver; the customer then gets the driver-assigned email.

## 3. Stripe approach and why it fits
* **SetupIntent** (`usage=off_session`) saves the card with consent and runs any SCA *now* while the customer is present. A SetupIntent never authorizes or holds funds, which is exactly the "no initial charge, no hold" requirement. (Authorize-now/capture-later is not used: it holds funds before approval.)
* The charge is a **PaymentIntent with `confirm=true` against the saved card, created at the moment of the customer's confirmation, on-session** (`off_session` is *not* set, because the customer is present). If the issuer wants authentication Stripe returns `requires_action` and the browser completes it; nothing is assumed chargeable without authentication.
* Idempotency keys: customer `cust-<booking>`, SetupIntent `setup-<booking>-<previous intent|first>`, charge `charge-<payment id>`. A unique partial index (`payments_one_live_saved_card_attempt`) allows only **one live charge attempt per booking**, so simultaneous clicks/tabs join one attempt.
* Unknown outcomes (dropped connection, Stripe outage, idempotency-key collision) leave the attempt *processing* (never falsely failed); a retry re-sends the same idempotency key and learns the real result.
* Webhooks (signature verified, already existing): `setup_intent.succeeded` (finalizes the card even if the tab was closed), `payment_intent.processing|requires_action|payment_failed|canceled|succeeded`. All updates are conditional on the payment still being live and unpaid, so duplicates, delays and out-of-order events cannot undo or duplicate a payment, and a success whose amount/currency/booking/customer does not match is flagged for review, never paid.
* Pricing: the amount is always `chargeForBooking()` (the existing pricing engine's stored total, tier + trip estimate + Meet & Greet + child seats) recalculated on the server; the browser never sends an amount, customer or card. **Deposit settings no longer shrink a card charge: the COMPLETE approved total is charged** (deposits still apply to PayPal).

## 4. Status model (no conflicting system)
`new_request` -> **`approved`** (new: admin approved, customer must confirm) -> `confirmed` (customer confirmed + verified payment) -> `assigned` -> existing driver steps. Booking `payment_status` gained `card_saved`, `processing`, `requires_action`; payments gained `processing`, `requires_action`. Older values and statuses still work. `customer-stage.ts` is the single definition used by the tracker, the booking page and the admin dashboard.

Admin checklist on every booking: Card setup completed / Admin approval / Customer confirmation received / Payment verified / Confirmed, ready for driver assignment (+ payment processing/failed notes). Approval (`approved_at`, set only by the admin route) and customer confirmation (`customer_confirmed_at`, set only by the customer's confirm call) are separate recorded actions; neither can be forged through the generic editor.

## 5. Removed
* Hosted Stripe Checkout creation, `startAuthorization`, `captureAuthorization`, `/api/payments/authorize`, `AuthorizeCardButton`, `PayButton`, the admin "capture payment" action, `approve_assign`, `payUrl`/`authorizeUrl`, the `_payUrl` approval email, the old confirmation wording.
* Kept: Stripe itself, PayPal (now offered on an *approved* booking as an alternative: `/pay/<token>` is PayPal-only and requires approval), existing payment history and in-flight webhook handling for old rows, all pricing, tracker, chat, driver and admin features.

## 6. Existing bookings (not migrated, not charged)
* Bookings created before this change have `card_flow=false`. They are untouched. If an admin approves one, the customer adds a card (or uses PayPal) on their own booking page and must still confirm before anything is charged.
* A booking that still holds an old card authorization has that hold **released (never captured)** when approved, declined or cancelled. Nothing is charged automatically.
* A booking approved and assigned *before* this deploy and still unpaid keeps its driver; it is still gated (no ride progress until a verified payment) and the customer confirms the same way.

## 7. Files changed
**New:** `supabase/migrations/0016_saved_card_workflow.sql`, `src/lib/saved-card.ts`, `src/lib/payments-core.ts`, `src/lib/customer-stage.ts`, `src/lib/card-consent.ts`, `src/lib/customer-request.ts`, `src/lib/customer-client.ts`, `src/lib/stripe-client.ts`, `src/lib/booking-notices.ts`, `src/components/CardSetupStep.tsx`, `src/components/BookingActions.tsx`, `src/components/ConfirmationLive.tsx`, `src/app/api/bookings/card/setup/route.ts`, `.../card/complete/route.ts`, `.../confirm/route.ts`, `.../confirm/finalize/route.ts`.
**Rewritten/changed:** `src/lib/stripe.ts`, `payments-server.ts`, `booking-status.ts`, `trip.ts`, `tracking.ts`, `confirmation.ts`, `fare/booking.ts`, `notify/templates.ts`, `notify/index.ts`, `admin/resources.ts`, `app/api/bookings/route.ts`, `app/api/admin/bookings/workflow/route.ts`, `app/api/payments/checkout/route.ts`, `app/(site)/book/confirmation/page.tsx`, `app/(site)/pay/[token]/page.tsx`, `components/{BookingForm,ConfirmationDetails,TripStatus,PaymentChoice,admin/BookingWorkflow,admin/ResourceManager}.tsx`, `app/admin/(panel)/{bookings/[id],payments}/page.tsx`, README.
**Deleted:** `app/api/payments/authorize/route.ts`, `components/AuthorizeCardButton.tsx`, `components/PayButton.tsx`.
**Tests:** `tests/workflow.test.ts` (old-flow tests replaced, new acceptance tests added), `tests/integration/fakedb.mjs` (partial unique index).

## 8. Deployment (manual: nothing is run automatically)
1. In Supabase SQL editor run `supabase/migrations/0016_saved_card_workflow.sql` (additive, idempotent; after 0015). Do this **before** deploying the code.
2. Vercel env: add `STRIPE_PUBLISHABLE_KEY` (`pk_live_...`; `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` also works). `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_SITE_URL` (public https URL) must already be set. No rebuild is needed to change the publishable key.
3. Stripe dashboard -> Webhooks: add `setup_intent.succeeded`, `setup_intent.setup_failed`, `payment_intent.processing`, `payment_intent.requires_action`, `payment_intent.payment_failed`, `payment_intent.canceled` (keep `payment_intent.succeeded`, `charge.refunded`, and the existing `checkout.session.*` events).
4. Admin -> Booking settings: online payment mode must not be `disabled` and Stripe must be switched on (otherwise bookings are requests only, with no card step). `stripe_authorize_at_booking` is now ignored.
5. Deploy, then run the live checks below.

## 9. Live verification still required (only mocks were available here)
Using Stripe **test mode** first: (a) book -> card step shows the Payment Element, pay with `4242 4242 4242 4242`; the Stripe dashboard shows a Customer with the card and a SetupIntent, **no PaymentIntent**; (b) approve in admin, confirm no charge appeared; (c) press Confirm on the tracker/booking page -> one PaymentIntent for the full total, booking becomes Confirmed, driver assignment becomes available; (d) card `4000 0025 0000 3155` (authentication) completes in the page; (e) `4000 0000 0000 9995` (insufficient funds) shows the decline message and allows retry/other card; (f) replay a webhook from the dashboard and confirm nothing duplicates; (g) check the Brevo approval email opens the tracker and contains no `/pay/` link.

## 10. Known behaviours to be aware of
* The customer's explicit confirmation is accepted from the private booking token **or** the tracking ID (the credential that already opens the tracker). Keep the tracking ID private.
* Bookings with no online amount (no tier price) cannot be confirmed online (unchanged from before): approving one shows "we will arrange payment with you".
* Online payment disabled or Stripe not configured => bookings remain plain requests (no card step) exactly as before.
