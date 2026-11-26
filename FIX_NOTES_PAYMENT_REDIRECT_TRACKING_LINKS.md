# Post-booking card step and direct tracking links

## What the code did before
- Submitting a booking already redirected to Stripe's hosted **authorize-now / capture-later** page, but **only** when the admin setting
  "Authorize the card at booking, capture on approval" (`booking_settings.stripe_authorize_at_booking`, default OFF) is on and Stripe session creation succeeded.
  Otherwise the customer landed on a confirmation page with no way to pay, and payment opened only after admin approval (`/pay/[token]`).
- The Stripe return pages used the guessable `VT-` reference; cancelling or failing the card step gave no retry or resume; a repeated
  submission (same `submissionKey`) never reached the card step.
- Emails already had a "Track your ride" button (`/track#id=...`), but the Tracking ID text itself was not a link, and some emails (reschedule) had no link at all.

## What changed
1. **Card step for the exact booking** (`src/lib/payments-server.ts`, `src/app/api/bookings/route.ts`, `BookingForm.tsx`)
   - Stripe success/cancel URLs now return to `/book/confirmation?t=<private payment token>` (never the VT- reference).
   - A repeated submission now resumes the same booking's card step. An unfinished hosted page for the same amount is **reused** (no new payment row), so refresh/double-click cannot create two holds; a booking that already holds a card is refused (`already_authorized`).
   - The booking response includes `confirmUrl` (private-token page) as the fallback redirect when the card page cannot be opened.
2. **Resume / retry** (`POST /api/payments/authorize`, `AuthorizeCardButton.tsx`): token only, same-origin, rate-limited. Amount and booking are resolved on the server.
3. **Customer booking page** (`src/app/(site)/book/confirmation/page.tsx`, `src/lib/confirmation.ts`): shows price, honest card state (held / pending / failed / not held / paid), a retry button, the Pay link once approved, and the tracking ID as a link plus a **Track Your Ride** button. Customer-safe fields only. Old `?ref=` links still work.
4. **Tracking links** (`src/lib/tracking-url.ts`, `notify/templates.ts`, `notify/index.ts`): one builder for `https://<site>/track#id=<TRACKING ID>`; the Tracking ID is a real `<a>` in the HTML email and its URL appears in the plain-text part for created, approved, confirmed and rescheduled emails. In production the base URL is forced to https and never localhost; with no usable site URL no link is emitted. The Admin config warnings list a missing/localhost `NEXT_PUBLIC_SITE_URL`.
5. **Track page**: also reacts to a hash change on an already-open page. Manual ID entry unchanged.

## Not changed
Pricing, capture/approval logic, webhook handling, RLS/migrations (none added), admin and driver features, Supabase schema.
The tracking link keeps the existing security model: random 60-bit tracking ID, in the URL fragment (never sent to servers or Referer), per-IP rate limits, identical 404 for unknown IDs.

## Must be set in production
`NEXT_PUBLIC_SITE_URL` = the public https address, and Admin setting "Authorize the card at booking" ON. With the setting OFF there is no card step at booking by design (payment before approval is blocked).
