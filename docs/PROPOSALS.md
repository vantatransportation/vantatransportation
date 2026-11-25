# Vanta Transportation: agreed work, decisions and proposals

Status date: 25 Nov 2026. Section 1 is **implemented and tested**. Sections 3 and 4 are **proposals only**: nothing in them is built, and no paid service is connected. Flight tracking is **out of scope** for now (section 5).

---

## 1. Implemented (agreed workflow corrections)

| Requirement | What the code does now |
|---|---|
| Driver phone | In the admin driver form, list and search. Existing numbers untouched. Shown only to signed-in admins (form, list, and the Overview follow-up list). Never sent to the tracking page, tracking API, customer emails or the driver pages. Email stays (driver sign-in). |
| Getting Ready | Exact label **Getting Ready**. An acknowledgement only. No time restriction, on screen or on the server. |
| Admin follow-up | The admin Overview lists confirmed, **paid** rides with an assigned driver who has not acknowledged yet (booking still `assigned`/`confirmed`), earliest pickup first, with the driver's phone as a `tel:` link. |
| Leave for Pickup | Separate action. Temporary rule kept: the server refuses it earlier than **240 minutes (4 h)** before pickup. Editable under Booking settings ("Leave for Pickup opens"). |
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

## 2. Decision still needed: what "Start Ride" means

There is **no button called Start Ride today**. The step that marks the ride actually beginning is **Passenger picked up** (`picked_up`). I did not change any transition.

| Option | Change | Effect on tracking | Effect on chat | Effect on completion |
|---|---|---|---|---|
| **A (recommended): `picked_up` *is* Start Ride** | Relabel the button only (for example "Start ride"). No status change. | Unchanged: the customer already sees "Passenger picked up, ride in progress". | Unchanged: chat is open from 24 h before pickup to the end of the ride. | Unchanged: `picked_up → completed`. |
| B: separate status `arrived → in_progress` | Driver taps Start Ride from Arrived; the `picked_up` button is retired from the driver screen. | `in_progress` already shares the same tracking step as `picked_up`, so the tracking wording would need a small change to tell them apart. | Unchanged (both are open ride states). | `in_progress → completed` already exists for drivers. Existing `picked_up` rows still complete. |

**Question:** is Start Ride simply the moment the passenger is on board (Option A)? If you need it as a different moment, tell me which, and I will not change transitions until you answer. No timing rule is proposed for Start Ride.

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

## 4. Proposal: Stripe authorize now, capture on approval (not implemented)

### Stripe constraints (from Stripe's documentation, checked 25 Nov 2026)
- Manual-capture holds on cards are normally valid for **7 days** for online payments.
- **Visa merchant-initiated holds are 5 days (4 days 18 hours).** A payment the customer confirms on-session counts as customer-initiated. Stripe returns the real deadline per payment (`capture_before`), so the code should read that field and not hard-code a number.
- **Extended authorizations (up to 30 days)** exist only for certain card networks and merchant categories. Chauffeur or transportation may not qualify.
- Other payment methods (for example PayPal through Stripe) have their own, different hold periods; some are shorter.
- **I cannot see your Stripe account.** Whether manual capture, extended authorizations and your merchant category allow longer holds must be confirmed in the Stripe dashboard or with Stripe support. Until then I assume the standard window and design around the shortest one.

### Proposed flow
1. **Booking:** the customer enters the card in Stripe's Payment Element (card details never reach our server). The server creates a PaymentIntent for the amount **it computes**, `capture_method=manual`. Stripe handles 3-D Secure. The booking is created as awaiting approval.
2. **Authorized:** a verified `payment_intent.amount_capturable_updated` event records payment status `authorized` and the `capture_before` time. The customer is not charged.
3. **Approval:** the admin's **Approve and Capture Payment** re-reads the PaymentIntent from Stripe, checks the booking, amount and state, and captures on the server with an idempotency key. Only a verified capture event (`payment_intent.succeeded` / `charge.captured`) sets `paid`, which is what already enables confirmation, tracking driver details, chat and ride progress.
4. **Expiry warnings:** the admin dashboard lists authorizations by `capture_before` and warns at **48 h and 24 h** before it.
5. **Expiry or failed capture:** the payment status becomes **payment needed** (`authorization_expired` or `capture_failed`). The booking is **not cancelled and not confirmed automatically**; it stays unpaid and the admin follows up. The admin sees the customer's contact details, the card brand and last four digits only, and the failure reason, and can click **Request payment again**, which emails the customer a secure link to a **new** authorization (3-D Secure if required). A saved card is never charged without that customer step.
6. **Cancel or decline before capture:** cancel the PaymentIntent (releases the hold). After capture, the existing refund and cancellation rules apply unchanged. Reassigning a driver does not touch payment.
7. **SUV differences:** a separate payment for the difference, only after the customer accepts (section 3).
8. **Deposits:** the existing deposit or full-payment plan stays; the authorized amount equals what the plan charges today. **PayPal stays exactly as it is.**

### State model (booking and payment stay separate)
Existing payment statuses stay: `not_required, unpaid, pending, deposit_paid, paid, failed, refunded, partially_refunded, review`. **Added (additive CHECK change):** `authorized`, `capture_pending`, `capture_failed`, `authorization_expired`, `requires_action`. `PAID_STATES` is unchanged.

### Database changes (additive, none destructive)
`payments`: `capture_before`, `authorized_amount_cents`, `captured_amount_cents`, `card_brand`, `card_last4`, `capture_attempts`, `last_error`. A table for retry links (token hash, booking, expiry, used time). The existing webhook-event table is reused for idempotency.

### Webhooks and safety
Verify the signature on every event; process each event id once; ignore an older event when a newer valid state is already recorded; handle duplicates and retries safely. Events: `payment_intent.amount_capturable_updated`, `.succeeded`, `.payment_failed`, `.canceled`, `.requires_action`, `charge.captured`, `charge.expired`, `charge.refunded`, `charge.dispute.created`. Never store card numbers or CVV. The browser needs `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`; the secret key and webhook secret stay server-side. Test with Stripe test mode only.

### Costs
I found no separate Stripe fee for manual capture; standard processing fees apply. Confirm in your Stripe pricing. (Note that Stripe's processing fee on a refunded payment is generally not returned, per Stripe's pricing terms; confirm for your account.)

**Decisions needed before any Stripe coding:** (1) approve this flow; (2) confirm in your Stripe account what hold length applies to your merchant category; (3) does an unapproved booking wait until its hold expires (then "payment needed"), or does the admin have a target approval time; (4) allow saving a card for later (off by default)?

---

## 5. Flight tracking: out of scope

Removed from the current scope at the client's request: no API research, no integration, no database changes, no notifications. The airport form and its flight number and flight date fields are unchanged and work as before. It can be revisited later if the client asks and approves the cost.

---

## 6. Open decisions (summary)

1. Start Ride meaning: Option A or B (section 2).
2. Luggage unit rule and `luggage_capacity` data (section 3).
3. Extra SUV payment timing (section 3).
4. Stripe: approve the flow, confirm your hold length, approval-wait behaviour, saved cards (section 4).
5. Final Leave for Pickup rule (the 4-hour window stays until you decide).
6. Who may approve pickup changes: currently **admin only**; any fee or limit on changes is not defined and was not invented.

## 7. Deployment order
Run `0012_driver_profile.sql`, then `0013_phase2.sql` (both additive and safe to repeat), then deploy. Configure the Vanta support number under Website content (`contact.phone`) if it is empty.
