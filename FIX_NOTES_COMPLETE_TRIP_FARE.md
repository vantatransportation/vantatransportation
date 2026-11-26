# Complete trip fare fix — notes

**Root cause.** `onlineCharge()` (src/lib/tier-pricing.ts) built the amount to authorize/charge as `tier fixed fee + Meet & Greet + child seats`. The
server-calculated trip fare (distance/hourly, surcharges, tolls, discounts, round trip; stored in `bookings.estimated_fare_cents`) was deliberately
left out and shown as "information only". That frozen `online_amount_cents` is what Stripe/PayPal charged, so customers were undercharged.

**Now.** Total = tier fixed fee + trip estimate + Meet & Greet (if selected) + child seats, computed on the server, frozen in
`bookings.online_amount_cents` (existing column, no schema change). Customers see `Trip fare` (= fee + estimate, derived), the selected services, `Total`.
If the trip estimate is unavailable there is no online charge (never the fee alone).

**Deploy.** Apply `supabase/migrations/0015_hide_tier_fixed_fee_from_public.sql` (idempotent; revokes anon/authenticated read of
`vehicle_tiers.fixed_price_cents`). Then deploy the app. No data is changed.

**Decisions to confirm.** (1) Quote conversions at an agreed price still have no automatic online charge. (2) `rush_surcharge_cents`/`tip_cents` columns were never part of
the online amount and still are not (rush rules configured in pricing surcharges are already inside the trip estimate). (3) Bookings made before this fix that
have no hold/payment yet are re-priced once to the complete total (audit entry `booking.charge_upgraded`); any booking with a hold/payment keeps its amount.
(4) Tracking-by-code still shows no prices (unchanged); the private pay/tracking link shows the safe breakdown.
