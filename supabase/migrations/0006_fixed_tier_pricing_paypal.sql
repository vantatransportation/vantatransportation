-- Vanta upgrade 3: exactly three tiers with admin-set fixed prices, per-tier Meet & Greet fees,
-- a shared Stripe + PayPal payment model. Run AFTER 0001-0005. Safe to re-run; no rows are deleted.

-- 1. Tier pricing columns. NULL fixed price = "not configured yet": online payment stays unavailable for that tier.
alter table public.vehicle_tiers
  add column if not exists fixed_price_cents int check (fixed_price_cents is null or fixed_price_cents > 0),
  add column if not exists meet_greet_fee_cents int check (meet_greet_fee_cents is null or meet_greet_fee_cents > 0);

-- 2. Exactly three tiers. Existing rows are RENAMED in place, so vehicle assignments and bookings keep pointing at them.
--    Lowest tier -> Premium, middle -> Luxury, any old "Super Luxury" -> Luxury Plus.
update public.vehicle_tiers v set name = 'Premium', slug = 'premium', sort_order = 1, is_active = true
  where v.slug in ('economical', 'business-class', 'economy', 'premium')
    and not exists (select 1 from public.vehicle_tiers t where t.slug = 'premium' and t.id <> v.id);
update public.vehicle_tiers v set name = 'Luxury', slug = 'luxury', sort_order = 2, is_active = true
  where v.slug in ('luxury', 'first-class')
    and not exists (select 1 from public.vehicle_tiers t where t.slug = 'luxury' and t.id <> v.id);
update public.vehicle_tiers v set name = 'Luxury Plus', slug = 'luxury-plus', sort_order = 3, is_active = true
  where v.slug in ('super-luxury', 'super_luxury', 'luxury-plus')
    and not exists (select 1 from public.vehicle_tiers t where t.slug = 'luxury-plus' and t.id <> v.id);
-- Luxury Plus is new for most installs. No vehicle is assigned to it automatically: assign vehicles in Admin, Vehicles.
insert into public.vehicle_tiers (name, slug, description, sort_order, is_active)
  select 'Luxury Plus', 'luxury-plus', 'Our highest service tier.', 3, true
  where not exists (select 1 from public.vehicle_tiers where slug = 'luxury-plus');
-- Anything else is retired from use (kept, not deleted, so historical records still resolve).
update public.vehicle_tiers set is_active = false where slug not in ('premium', 'luxury', 'luxury-plus');

-- Descriptions: only replace the previous default wording.
update public.vehicle_tiers set description = 'Comfortable luxury vehicles for business and everyday travel.'
  where slug = 'premium' and (description is null or description in ('Comfortable luxury vehicles for business and everyday travel.', 'Comfortable, well-kept vehicles at a lower rate.'));
update public.vehicle_tiers set description = 'Our luxury vehicles with the full chauffeur experience.'
  where slug = 'luxury' and (description is null or description = 'Premium vehicles and the full chauffeur experience.');

-- 3. Business-approved initial Meet & Greet fees (only where no fee is set yet; editable in Admin afterwards).
update public.vehicle_tiers set meet_greet_fee_cents = 2500 where slug = 'premium' and meet_greet_fee_cents is null;
update public.vehicle_tiers set meet_greet_fee_cents = 3500 where slug = 'luxury' and meet_greet_fee_cents is null;
update public.vehicle_tiers set meet_greet_fee_cents = 5000 where slug = 'luxury-plus' and meet_greet_fee_cents is null;
-- Fixed prices are deliberately NOT set. The administrator must enter all three (Admin, Tier prices & fees).

-- 4. Bookings: snapshot of what the customer chose and what the online charge is, frozen at request time.
alter table public.bookings
  add column if not exists tier_name text,
  add column if not exists fixed_price_cents int check (fixed_price_cents is null or fixed_price_cents >= 0),
  add column if not exists meet_greet_selected boolean not null default false,
  add column if not exists meet_greet_fee_cents int check (meet_greet_fee_cents is null or meet_greet_fee_cents >= 0),
  add column if not exists online_amount_cents int check (online_amount_cents is null or online_amount_cents >= 0);
-- Existing bookings keep their data; their snapshot columns stay NULL (no online charge was ever defined for them).

-- 5. Shared payment model: one row per payment attempt, for Stripe or PayPal.
alter table public.payments
  add column if not exists provider text not null default 'stripe' check (provider in ('stripe', 'paypal')),
  add column if not exists provider_ref text,            -- Stripe Checkout session id / PayPal order id
  add column if not exists provider_txn_id text,         -- Stripe payment intent id / PayPal capture id
  add column if not exists tier_id uuid references public.vehicle_tiers(id) on delete set null,
  add column if not exists tier_name text,
  add column if not exists fixed_price_cents int,
  add column if not exists meet_greet_cents int not null default 0,
  add column if not exists other_addons_cents int not null default 0,
  add column if not exists estimated_trip_fare_cents int; -- informational only; never charged through this flow
update public.payments set provider_ref = stripe_session_id where provider_ref is null and stripe_session_id is not null;
update public.payments set provider_txn_id = stripe_payment_intent_id where provider_txn_id is null and stripe_payment_intent_id is not null;
create unique index if not exists payments_provider_ref_idx on public.payments(provider, provider_ref) where provider_ref is not null;
create index if not exists payments_provider_txn_idx on public.payments(provider, provider_txn_id);

-- 6. PayPal webhook idempotency (Stripe already has stripe_events).
create table if not exists public.paypal_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);
alter table public.paypal_events enable row level security;
drop policy if exists "admin full access" on public.paypal_events;
create policy "admin full access" on public.paypal_events for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 7. Provider switches (a provider is offered only if it is switched on here AND configured on the server).
alter table public.booking_settings
  add column if not exists stripe_enabled boolean not null default true,
  add column if not exists paypal_enabled boolean not null default true;
-- The old single Meet & Greet charge columns are no longer used (fees are per tier). They are kept for history.
