-- 0009: unguessable customer tracking ID + "booking confirmed after verified payment".
-- ADDITIVE AND IDEMPOTENT. Run AFTER 0001-0008, once. Nothing is dropped, truncated or rewritten except the backfill
-- below, which only fills NULL tracking codes. Safe to apply to a live database: it takes brief row locks on `bookings`.

-- 1. Tracking code generator: 'TRK-' + 15 random hex characters in three groups of five (60 bits, from gen_random_uuid()).
--    Sequential booking references such as VT-1004 are NEVER accepted as a credential; only this code is.
create or replace function public.new_tracking_code() returns text
language sql volatile as $$
  select 'TRK-' || upper(substr(h, 1, 5)) || '-' || upper(substr(h, 6, 5)) || '-' || upper(substr(h, 11, 5))
  from (select replace(gen_random_uuid()::text, '-', '') as h) s
$$;

-- 2. Booking columns.
alter table public.bookings
  add column if not exists tracking_code text,
  -- Set once, by the server, when a payment has been VERIFIED by Stripe or PayPal. Never set by an admin click or a browser return.
  add column if not exists confirmed_at timestamptz;

-- 3. Backfill existing bookings (only rows without a code) so their customers can be given a tracking ID.
update public.bookings b
   set tracking_code = public.new_tracking_code()
 where b.tracking_code is null;

-- 4. New bookings get a code even if an insert path forgets to supply one.
alter table public.bookings alter column tracking_code set default public.new_tracking_code();
create unique index if not exists bookings_tracking_code_key on public.bookings (tracking_code);
alter table public.bookings drop constraint if exists bookings_tracking_code_format;
alter table public.bookings add constraint bookings_tracking_code_format check (tracking_code is null or tracking_code ~ '^TRK-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$');

-- 5. Rides may only progress once confirmed_at is set (enforced by the app). So that rides ALREADY in flight are not stranded,
--    mark as confirmed ONLY bookings that already have a provider-verified paid payment row. No email is sent, nothing is charged.
update public.bookings b
   set confirmed_at = coalesce((select min(p.paid_at) from public.payments p where p.booking_id = b.id and p.paid_at is not null), now())
 where b.confirmed_at is null
   and b.payment_status in ('paid', 'deposit_paid', 'partially_refunded')
   and b.status in ('assigned', 'confirmed', 'getting_ready', 'on_the_way', 'arrived', 'picked_up', 'in_progress')
   and exists (select 1 from public.payments p where p.booking_id = b.id and p.paid_at is not null);

-- Bookings that are approved/in flight but NOT paid are deliberately left unconfirmed and will wait for payment.
-- To see them before deploying:
--   select reference, status, payment_status from public.bookings
--    where confirmed_at is null and status in ('assigned','confirmed','getting_ready','on_the_way','arrived','picked_up','in_progress');

-- RLS: nothing to change. `bookings` is admin-only (0002); customers and drivers reach their booking only through server routes
-- that check the tracking code / token / driver session with the service role, so direct Supabase queries return nothing.
