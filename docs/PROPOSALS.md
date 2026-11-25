# Vanta Transportation: agreed work, decisions and proposals

Status date: 26 Nov 2026. **Implemented and tested in code (mocked providers only, never live):** section 1 (workflow), section 4 (Stripe authorize/capture) and section 6 (analytics). **Proposal only, not built:** section 3 (SUV upgrades). Section 2 is a decision still needed. Flight tracking is **out of scope** (section 5).

---

## 1. Implemented (agreed workflow corrections)

| Requirement | What the code does now |
|---|---|
| Driver phone | In the admin driver form, list and search. Existing numbers untouched. Shown only to signed-in admins (form, list, and the Overview follow-up list). Never sent to the tracking page, tracking API, customer emails or the driver pages. Email stays (driver sign-in). |
| Getting Ready | Exact label **Getting Ready**. An acknowledgement only. No time restriction, on screen or on the server. |
| Admin follow-up | The admin Overview lists confirmed, **paid** rides with an assigned driver who has not acknowledged yet (booking still `assigned`/`confirmed`), earliest pickup first, with the driver's phone as a `tel:` link. |
| Leave for Pickup | Separate action. Temporary rule kept: the server refuses it earlier than **240 minutes (4 h)** before pickup. Editable under Booking settings ("Leave for Pickup opens"). |
| Start Ride | The existing **Passenger picked up** step (`picked_up`, not renamed). The server refuses it earlier than **exactly 2 hours** before pickup (server clock); the dashboard shows it disabled with the unlock time. **Conflict to confirm:** an earlier message said not to put a two-hour rule on Start Ride; the latest brief says to. I followed the latest. Removing it is one condition in `src/app/api/driver/status/route.ts`. |
| Chat | Opens **24 hours before the current pickup time**, stays open through the ride, closes on completion or cancellation. Server checks, on every read-for-send and every send, from the freshly loaded booking: customer credential or the assigned driver, driver assigned, booking confirmed and payment verified, ride not over, inside the window. Admins keep read-only access on the booking page. |
| Pickup changes | A chat message never changes the booking. An admin applies a change with **Reschedule pickup** on the booking page (admin-only). The old and new times are recorded in the booking history and the activity log, the customer and the assigned driver are emailed, and the chat window is recalculated because it always reads the current pickup time. The generic booking editor can no longer edit pickup time silently. |

### Why the one new database field exists
`booking_settings.driver_dispatch_window_minutes` (default 240, additive, in migration `0013_phase2.sql`). It lives on the existing settings row so an admin can change the temporary 4-hour rule without a redeploy. It is the only field added for dispatch. There is no per-driver buffer, no travel-time calculation, and no other dispatch logic.

### Time zones and rescheduled bookings
- `bookings.pickup_at` is a `timestamptz` (an absolute instant, stored in UTC).
- Reschedule times are entered in the business time zone (`BUSINESS_TIMEZONE`, default `America/New_York`) and converted to UTC on the client with the same helper the other admin forms use, so daylight-saving changes are handled by the time-zone database, not by hand.
- Every window (chat 24 h, Leave for Pickup 4 h) is computed from the instant, so it is exactly 24 or 4 **elapsed** hours even across a clock change.
- Emails, the admin pages and the driver page display times in the business time zone. A reschedule is refused for bookings that are completed, cancelled, rejected, no-show, or whose passenger is already on board; it must be in the future and different from the current time; and it only applies if the status and time have not changed since the admin loaded the page (so two admins cannot overwrite each other).

### Ride statuses: current behaviour (documented, not changed)
`assigned/confirmed → getting_ready (Getting Ready) → on_the_way (Leave for Pickup) → arrived → picked_up (Passenger picked up) → completed`.
- A driver may also go straight from assigned to Leave for Pickup (skipping Getting Ready). That is today's behaviour and is unchanged.
- Admins can cancel at any open step or record a no-show from assigned/confirmed/arrived. Drivers cannot cancel or record no-shows.
- The legacy status `in_progress` exists and behaves like `picked_up` (can be completed).

---

## 2. Start Ride: what is implemented and what is still a decision

**Implemented (no status model change):** Start Ride **is** the existing "Passenger picked up" step. It keeps its name and place in the flow; only the exact 2-hour server-side lock was added (section 1).

**Existing flow, unchanged:** `assigned/confirmed → getting_ready → on_the_way → arrived → picked_up → completed` (a driver may also go straight from assigned to Leave for Pickup, still subject to the 4-hour rule). `in_progress` is a legacy status that behaves like `picked_up`.

**Still a decision (nothing built):** whether Start Ride should instead be a *new* step `arrived → in_progress` with the `picked_up` button retired. Effects if you choose that: tracking would need small wording changes (both share one tracking step today), chat is unaffected (open for both), and completion already works from `in_progress`. I recommend **not** doing this; the current mapping needs no change.

---

## 3. Proposal: sedan booked, SUV required (nothing built)

### What exists today
- Vehicles carry `passenger_capacity` and `luggage_capacity`. The server already hides, and rejects at booking, vehicles whose passenger capacity is below the party size.
- **`luggage_capacity` is never checked.** The form collects `checked_bags` and `carry_on_bags` (counts only, no size).
- Pricing is the existing fixed price per vehicle and tier. An SUV in the same tier already has its own fixed price. No pricing change is proposed.

### Proposed behaviour
1. **At booking:** a rule "5 or more passengers requires an SUV" (setting, default 5) plus a luggage check against the vehicle's `luggage_capacity`. If the chosen vehicle is too small, the customer is told why and is shown the suitable SUV cards with their existing final prices. Nothing is switched silently, and the server re-checks.
2. **Capturing luggage:** add a simple unit rule instead of asking for sizes: count each **checked bag as 1 unit and each carry-on as ½**, compared with the vehicle's `luggage_capacity`. Optional extra question "Any oversized items (golf clubs, strollers, skis)?" adds 1 unit each. Admins fill `luggage_capacity` per vehicle (it exists; it must be populated).
3. **Need discovered after booking:** the admin proposes the SUV on the booking page. The customer gets an email with a secure link showing the **revised vehicle and revised total** and an **Accept** button. Only after they accept is the extra amount collected through the approved Stripe workflow (a separate payment for the difference). Only a verified Stripe event marks it paid.
4. **If the customer declines:** the booking and price stay **unchanged**, and the booking is flagged for admin review so an admin can pick a suitable vehicle or contact the customer.
5. **Record:** a history row with the original vehicle, proposed vehicle, old and new fare, reason, who proposed it, customer acceptance time, payment reference and status.

**Decisions needed:** the luggage unit rule above (or your own), confirmation that `luggage_capacity` can be filled in for each vehicle, and whether the extra amount is paid at acceptance or later.

---

## 4. Stripe: authorize now, capture on admin approval (IMPLEMENTED, mocked-provider tests only)

### How it works
1. **Owner switch (off by default):** Booking settings > "Authorize the card at booking, capture on approval". Until it is on, nothing changes and the old pay-after-approval flow runs. Turn it on only after the test-mode checks below.
2. **Booking:** the booking is saved, then the customer is sent to **Stripe's hosted Checkout page** in manual-capture mode to hold their card (Stripe handles card entry and 3-D Secure; no card data reaches our server, no new dependency). The held amount is computed on the server from the existing fixed-tier pricing and payment plan (deposit or full); the browser's numbers are ignored. If the customer abandons the card step, the booking is still saved and follows the normal pay-link flow after approval. If Stripe is unavailable, the booking is never blocked.
3. **Hold recorded:** only a signature-verified `payment_intent.amount_capturable_updated` event marks the payment `authorized`, and the server then reads the payment from Stripe to store the hold's expiry (`capture_before`) and the card brand and last four digits. A hold never marks anything paid.
4. **Approve & Capture Payment (admin only):** approval assigns the driver, then captures. Before any money moves the server checks: the payment belongs to this booking; Stripe's own record agrees (booking, currency, state `requires_capture`, held amount); and the amount equals what the pricing and payment plan say is due. A conditional status change claims the capture, so a double click or retry cannot capture twice, and Stripe's idempotency key is per attempt.
5. **Paid only when Stripe confirms:** the payment is marked paid only from Stripe's own reply to the capture call or a verified `payment_intent.succeeded` event. Then the existing confirmation (booking confirmed, tracking driver details, confirmation email, chat, ride progress) runs once. No "please pay" email is sent when the capture succeeded.

### Failure and expiry handling
| Situation | What happens |
|---|---|
| Capture fails (declined, network, unexpected state) | Payment `capture_failed`, booking payment status **needs_payment**; booking stays approved and **unpaid**; admin alert + dashboard banner; customer is emailed the existing secure payment link; admin can **Retry capture payment**. |
| Hold expired (Stripe canceled it or `charge.expired`) | Payment `authorization_expired`, booking **needs_payment**. **The booking is not cancelled, confirmed or declined automatically** (no deadline). Admin follows up; the customer can pay again with the secure link. |
| Customer pays again | A fresh payment (immediate capture) via the existing pay page; any old hold or failed attempt is released first so they are never charged twice. Marked paid only by the verified event. |
| Admin declines or cancels before capture | The hold is released at Stripe and the payment marked `canceled`. After capture, the existing refund process is unchanged (still done by an admin in Stripe/PayPal). |
| Duplicate, delayed or out-of-order webhooks | Each Stripe event id is processed once; a late "authorized" cannot revive an expired or canceled payment; amounts, currency and booking are cross-checked and mismatches are flagged for review, not trusted. |
| Browser or redirect | Nothing the browser sends can mark a booking paid; the card return page only shows a message. |

### Expiry alerts
The admin Overview has a **Card authorizations** list: soonest expiry first, highlighted within 48 h and 24 h, and "needs payment" rows with the customer's contact details. This is a dashboard alert only. There is **no scheduled job** in the project, so no automatic emails are sent for approaching expiry; adding one would need a scheduler (decision below).

### Stripe constraints: what is known and what YOU must verify
- Documented by Stripe: manual-capture holds on cards are normally valid for **7 days** online; **Visa merchant-initiated holds are 5 days (4 days 18 hours)**; Stripe returns the real deadline per payment (`capture_before`), which the app stores and shows instead of assuming a number. Extended authorizations (up to 30 days) exist only for certain card networks and merchant categories; chauffeur or transportation may not qualify. Other payment methods hold for different, sometimes shorter, periods.
- **I cannot see your Stripe account.** In the dashboard or with Stripe support, verify: (1) card payments with manual capture are enabled; (2) your merchant category code and whether extended authorizations apply; (3) which cards or wallets your Checkout accepts (the hosted page may offer wallets that behave differently); (4) that `capture_before` appears on test payments.
- **Assumption to confirm in test mode:** the code treats `payment_intent.canceled` with `cancellation_reason: automatic` as an expired hold, and also handles `charge.expired`. Confirm what Stripe sends in your account.
- The app does not hold funds until the ride date. The money is captured **at approval**, so the hold only has to survive from booking to approval. Bookings approved after the hold lapses become "needs payment".

### Database changes (migration `0014_stripe_authorization.sql`, additive, safe to repeat)
`payments`: `manual_capture`, `capture_before`, `authorized_amount_cents`, `captured_amount_cents`, `card_brand`, `card_last4`, `capture_attempts`, `last_error`. Widened allowed values (old ones stay valid): payments `authorized, capture_pending, capture_failed, authorization_expired, canceled`; bookings `authorized, needs_payment`. `booking_settings.stripe_authorize_at_booking` (default off). No card numbers or CVVs are ever stored; only brand and last four.

### Webhook events to subscribe (Stripe dashboard > Developers > Webhooks)
Existing ones stay. **Add:** `payment_intent.amount_capturable_updated`, `payment_intent.succeeded`, `payment_intent.canceled`, `payment_intent.payment_failed`, `charge.expired`. Signature verification uses the existing `STRIPE_WEBHOOK_SECRET`. No new environment variables.

### Test-mode checklist (do before turning the switch on)
1. Stripe test mode keys + webhook endpoint with the events above. 2. Turn the switch on. 3. Book with test card 4242…; confirm the hold appears, booking page shows "authorized", nothing charged. 4. Approve; confirm capture, "paid", confirmation email once. 5. Repeat with a card that declines at capture and confirm "needs payment" and the payment-link email. 6. Decline a booking with a hold and confirm the hold is released. 7. Confirm PayPal still works unchanged.

**Not implemented (not requested or needs approval):** saving cards for future charges; scheduled expiry emails; automatic refunds; any change to PayPal.

---

## 5. Flight tracking: out of scope

Removed from the current scope at the client's request: no API research, no integration, no database changes, no notifications. The airport form and its flight number and flight date fields are unchanged and work as before. It can be revisited later if the client asks and approves the cost.

---

## 6. Phase 4: admin analytics (IMPLEMENTED)

Page: **Admin > Analytics** (admin-only, read-only, no new dependency: charts are inline SVG with a text alternative). Ranges: last 3, 6 or 12 months. No migration. No data is invented or back-filled.

| Metric | Definition |
|---|---|
| Completed rides per month | Bookings with status `completed`, by **scheduled pickup** month. |
| Upcoming rides | Status `confirmed`, `assigned` or `getting_ready` with a pickup in the future; also shows how many are in the next 7 days. |
| Average customer rating (per driver, all time) | Mean of `driver_ratings.stars` with the review count. A driver with none shows "no ratings". |
| Rating trend | Mean customer rating per month; a month with no ratings shows "no data", never zero. |
| Driver points comparison | `drivers.performance_points` (admin-set, separate from ratings). |
| Payment success rate | Succeeded (`paid`, `partially_refunded`, `refunded`) / (succeeded + failed, `capture_failed`, `authorization_expired`); "no data" when there are no attempts. Open = pending, authorized, capture in progress. |
| Collected / held | Sum of `paid` and `partially_refunded` payment amounts; sum of `authorized` holds (held, not charged). |

**Date handling:** months are bucketed in the business time zone (`BUSINESS_TIMEZONE`, default America/New_York), so a late-evening ride counts in its local month, including across daylight-saving changes. **Performance:** each query is capped at 5,000 rows and the page warns if a cap is hit. **Privacy:** only driver names, counts and money totals are read; no customer names, emails or phone numbers.

---

## 7. Open decisions (summary)

1. **Two-hour Start Ride:** keep the lock on "Passenger picked up" (latest brief) or remove it (earlier message)?
2. Start Ride as a new `arrived → in_progress` step: recommended **no** (section 2).
3. SUV upgrades: luggage unit rule and `luggage_capacity` data; extra payment at acceptance or later (section 3).
4. Stripe: confirm hold lengths for your account (section 4); optional scheduler for expiry emails; saved cards (off).
5. Final Leave for Pickup rule (the 4-hour window stays until decided).
6. Who approves pickup changes: currently **admin only**; no fee or limit was invented.

## 8. Deployment checklist
1. Back up the database. 2. Run migrations in order: `0012_driver_profile.sql`, `0013_phase2.sql`, `0014_stripe_authorization.sql` (all additive and safe to repeat). 3. Deploy the code. 4. Confirm the Vanta support number is set (Website content, `contact.phone`). 5. In Stripe, add the webhook events in section 4 (test mode first). 6. Complete the test-mode checklist in section 4. 7. Only then turn on "Authorize the card at booking, capture on approval". 8. Fill in each driver's car year, make, model and location when you next edit them.
