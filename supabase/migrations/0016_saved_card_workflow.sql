-- 0016: save card at booking (Stripe SetupIntent) -> admin approval -> customer confirmation -> charge the saved card.
-- ADDITIVE AND IDEMPOTENT. Run AFTER 0015. Nothing is dropped, reset or rewritten; existing bookings and payments keep their data.
-- Never stores card numbers or CVCs: only Stripe object ids plus the card brand and last four digits that Stripe itself displays.
--
-- DO NOT run this automatically in production. Apply it manually in the Supabase SQL editor BEFORE deploying the matching code.

-- 1. Bookings: the saved card and the two separate, recorded customer/admin actions.
alter table public.bookings
  add column if not exists card_flow boolean not null default false,                -- true = this booking collected a card at booking time (new workflow)
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_setup_intent_id text,
  add column if not exists stripe_payment_method_id text,
  add column if not exists card_setup_at timestamptz,                               -- Stripe confirmed (server-side) that the card was saved; nothing was charged or held
  add column if not exists card_brand text,
  add column if not exists card_last4 text,
  add column if not exists card_consent_at timestamptz,                             -- customer ticked the consent to save the card and charge it later for THIS booking
  add column if not exists card_consent_text text,                                  -- the exact wording shown when they consented
  add column if not exists customer_confirmed_at timestamptz;                       -- customer's explicit "Confirm Booking & Authorize Charge" (separate from admin approval: approved_at)

-- 2. Payments: charges of the saved card are ordinary rows in the existing table.
alter table public.payments
  add column if not exists saved_card boolean not null default false,
  add column if not exists stripe_payment_method_id text;

-- 3. Widen allowed values (old values stay valid).
do $$ begin
  alter table public.bookings drop constraint if exists bookings_status_check;
  alter table public.bookings add constraint bookings_status_check check (status in (
    'new_request','pending_confirmation','approved','confirmed','assigned','getting_ready','on_the_way','arrived','picked_up',
    'in_progress','completed','cancelled','rejected','no_show'));

  alter table public.bookings drop constraint if exists bookings_payment_status_check;
  alter table public.bookings add constraint bookings_payment_status_check check (payment_status in (
    'not_required','unpaid','pending','deposit_paid','paid','failed','refunded','partially_refunded','review',
    'authorized','needs_payment','card_saved','processing','requires_action'));

  alter table public.payments drop constraint if exists payments_status_check;
  alter table public.payments add constraint payments_status_check check (status in (
    'pending','paid','failed','expired','refunded','partially_refunded','review',
    'authorized','capture_pending','capture_failed','authorization_expired','canceled',
    'processing','requires_action'));
end $$;

-- 4. Database-level guard against double charging: at most ONE live saved-card charge attempt per booking, even under concurrent requests.
create unique index if not exists payments_one_live_saved_card_attempt
  on public.payments (booking_id)
  where saved_card and status in ('pending','processing','requires_action');

create index if not exists bookings_stripe_setup_intent_idx on public.bookings (stripe_setup_intent_id) where stripe_setup_intent_id is not null;
create index if not exists bookings_stripe_customer_idx on public.bookings (stripe_customer_id) where stripe_customer_id is not null;

-- 5. The old "authorize at booking, capture on approval" switch is no longer used by the application (the saved-card workflow
--    replaces it). The column is kept so that nothing is dropped; it is simply ignored.

-- EXISTING DATA
--  * Bookings created before this migration have card_flow = false. They are NOT migrated or charged. After an admin approves one, the
--    customer adds a card (or uses PayPal) on their own booking page and must confirm before anything is charged.
--  * Existing payments, holds and payment links are untouched. A booking that still holds an old card hold has that hold released when
--    an admin approves it (no charge), and the customer then follows the new flow.
--  * Stripe webhook: in the Stripe dashboard also send setup_intent.succeeded, setup_intent.setup_failed, payment_intent.processing,
--    payment_intent.requires_action (in addition to the events you already send).
