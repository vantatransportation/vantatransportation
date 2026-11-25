-- 0014: Stripe authorize-now / capture-on-admin-approval. Additive and backward compatible; safe to run more than once. Run AFTER 0013.
-- No data is changed or removed. Existing payments keep manual_capture = false and behave exactly as before.

alter table public.payments
  add column if not exists manual_capture boolean not null default false,
  add column if not exists capture_before timestamptz,
  add column if not exists authorized_amount_cents integer,
  add column if not exists captured_amount_cents integer,
  add column if not exists card_brand text,
  add column if not exists card_last4 text,
  add column if not exists capture_attempts integer not null default 0,
  add column if not exists last_error text;

-- Owner switch: authorize at booking is OFF until an admin turns it on (Booking settings). Existing behaviour is unchanged until then.
alter table public.booking_settings add column if not exists stripe_authorize_at_booking boolean not null default false;

-- Widen the allowed values (the old values stay valid). Constraint names are the ones Postgres generated for the inline checks.
do $$ begin
  alter table public.payments drop constraint if exists payments_status_check;
  alter table public.payments add constraint payments_status_check check (status in (
    'pending','paid','failed','expired','refunded','partially_refunded','review',
    'authorized','capture_pending','capture_failed','authorization_expired','canceled'));
  alter table public.bookings drop constraint if exists bookings_payment_status_check;
  alter table public.bookings add constraint bookings_payment_status_check check (payment_status in (
    'not_required','unpaid','pending','deposit_paid','paid','failed','refunded','partially_refunded','review',
    'authorized','needs_payment'));
end $$;

create index if not exists payments_capture_before_idx on public.payments(capture_before) where status = 'authorized';
