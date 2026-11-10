-- Vanta upgrade 2: Business/First Class tiers, Cloudinary vehicle photos, child seats, Stripe payments.
-- Run AFTER 0001-0004. Non-destructive: no rows are deleted, admin edits to names/labels are preserved.

-- 1. Tier names. Only rows still carrying the original seed names are renamed (admin edits are kept).
update public.vehicle_tiers set name = 'Business Class', slug = 'business-class',
  description = 'Comfortable luxury vehicles for business and everyday travel.'
  where slug = 'economical' and name = 'Economical';
update public.vehicle_tiers set name = 'First Class', slug = 'first-class'
  where slug = 'luxury' and name = 'Luxury';

-- 2. Category capacity labels requested by the client (only where still at the original seed text).
update public.vehicle_categories set capacity_label = '6–7 passengers' where slug = 'large-suvs' and capacity_label = '7–8 passengers';
update public.vehicle_categories set capacity_label = '2–3 passengers' where slug in ('full-size-sedans','mid-size-sedans') and capacity_label = 'Up to 4 passengers';
-- NOTE: vehicles.passenger_capacity is NOT changed. The server enforces each vehicle's own capacity.

-- 3. Vehicle photos (Cloudinary). image_url already exists; the public id is needed for safe replacement/deletion.
alter table public.vehicles add column if not exists image_public_id text;

-- 4. Admin-configurable child seat prices (client-specified initial values), and payment settings.
--    Payments stay DISABLED until an admin chooses a mode.
alter table public.booking_settings
  add column if not exists child_seat_one_way_cents int not null default 1000 check (child_seat_one_way_cents >= 0),
  add column if not exists child_seat_round_trip_cents int not null default 1500 check (child_seat_round_trip_cents >= 0),
  add column if not exists child_seat_max int not null default 4 check (child_seat_max between 0 and 10),
  add column if not exists payment_mode text not null default 'disabled' check (payment_mode in ('disabled','full','deposit_fixed','deposit_percent')),
  add column if not exists deposit_fixed_cents int check (deposit_fixed_cents is null or deposit_fixed_cents > 0),
  add column if not exists deposit_percent numeric(5,2) check (deposit_percent is null or (deposit_percent > 0 and deposit_percent <= 100)),
  add column if not exists payment_terms text;

-- 5. Bookings: child seats and payment state.
alter table public.bookings
  add column if not exists child_seats jsonb not null default '[]'::jsonb,
  add column if not exists child_seat_fee_cents int not null default 0 check (child_seat_fee_cents >= 0),
  add column if not exists payment_status text not null default 'not_required'
    check (payment_status in ('not_required','unpaid','pending','deposit_paid','paid','failed','refunded','partially_refunded','review')),
  add column if not exists amount_paid_cents int not null default 0 check (amount_paid_cents >= 0),
  add column if not exists payment_token uuid not null default gen_random_uuid();
create unique index if not exists bookings_payment_token_idx on public.bookings(payment_token);

-- 6. Payments (Stripe Checkout). Only references and amounts; never card data.
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  stripe_session_id text unique,
  stripe_payment_intent_id text,
  amount_cents int not null check (amount_cents > 0),
  currency text not null default 'USD',
  kind text not null check (kind in ('full','deposit')),
  status text not null default 'pending' check (status in ('pending','paid','failed','expired','refunded','partially_refunded','review')),
  failure_reason text,
  refunded_cents int not null default 0 check (refunded_cents >= 0),
  checkout_url text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists payments_booking_idx on public.payments(booking_id);
create index if not exists payments_intent_idx on public.payments(stripe_payment_intent_id);

-- Processed webhook event ids (idempotency).
create table if not exists public.stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['payments','stripe_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "admin full access" on public.%I', t);
    execute format('create policy "admin full access" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;
drop trigger if exists set_updated_at on public.payments;
create trigger set_updated_at before update on public.payments for each row execute function public.set_updated_at();

-- 7. FAQ: better-quote disclaimer (only if the FAQ still has the original answer).
update public.faqs set answer = 'Send us a query using Request a Better Quote. Requesting a better quote does not guarantee a lower price or discount. Each request is reviewed on a case-by-case basis, depending on trip details, distance, vehicle availability and other relevant circumstances.'
  where question ilike 'What if I do not like my quote%' and answer like 'Send us a query using Request a Better Quote%' and answer not like '%does not guarantee%';
update public.faqs set answer = 'By default the website takes booking requests and we confirm your booking with you directly. When online payment is turned on, you will see a Pay online option after you submit your request. A booking is not confirmed until we confirm it.'
  where question ilike 'Do I pay online%' and answer like 'No. The website accepts booking requests only%';

update public.site_content set value = '"Similar models may be provided."' where key = 'home.fleet_note' and is_placeholder = true;
