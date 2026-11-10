-- Vanta Transportation: core schema
-- Run in the Supabase SQL editor (or `supabase db push`). Safe to run once on a new project.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Admin authorization (no public registration: admins are added manually)
-- ---------------------------------------------------------------------------
create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'admin' check (role in ('admin','staff')),
  created_at timestamptz not null default now()
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Fleet: categories, tiers, vehicles (nothing is hard-coded in the app)
-- ---------------------------------------------------------------------------
create table public.vehicle_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  capacity_label text,
  image_url text,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.vehicle_tiers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.vehicle_categories(id) on delete restrict,
  tier_id uuid references public.vehicle_tiers(id) on delete set null,
  name text not null,
  slug text not null unique,
  similar_models text,
  description text,
  features text[] not null default '{}',
  passenger_capacity int not null check (passenger_capacity > 0),
  luggage_capacity int check (luggage_capacity is null or luggage_capacity >= 0),
  image_url text,
  is_active boolean not null default true,      -- shown on the public site
  is_available boolean not null default true,   -- can be booked right now
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index vehicles_category_idx on public.vehicles(category_id);
create index vehicles_tier_idx on public.vehicles(tier_id);

-- ---------------------------------------------------------------------------
-- Pricing (per vehicle; draft until an admin activates it)
-- ---------------------------------------------------------------------------
create table public.pricing_configs (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft','active','archived')),
  label text,
  notes text,
  currency text not null default 'USD',
  per_mile numeric(10,2) not null check (per_mile >= 0),
  hourly_rate numeric(10,2) check (hourly_rate is null or hourly_rate >= 0),
  minimum_fare numeric(10,2) not null default 0 check (minimum_fare >= 0),
  base_fare numeric(10,2) not null default 0 check (base_fare >= 0),
  hourly_included_miles numeric(10,2) not null default 20 check (hourly_included_miles >= 0),
  hourly_included_scope text not null default 'booking' check (hourly_included_scope in ('booking','per_hour')),
  hourly_extra_mile_rate numeric(10,2) not null default 0 check (hourly_extra_mile_rate >= 0),
  min_hours numeric(5,2) not null default 1 check (min_hours > 0),
  long_trip_threshold_miles numeric(10,2) check (long_trip_threshold_miles is null or long_trip_threshold_miles >= 0),
  long_trip_per_mile numeric(10,2) check (long_trip_per_mile is null or long_trip_per_mile >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Only one active pricing config per vehicle.
create unique index pricing_one_active_per_vehicle on public.pricing_configs(vehicle_id) where status = 'active';
create index pricing_vehicle_idx on public.pricing_configs(vehicle_id);

create table public.pricing_surcharges (
  id uuid primary key default gen_random_uuid(),
  pricing_config_id uuid not null references public.pricing_configs(id) on delete cascade,
  label text not null,
  kind text not null check (kind in ('flat','percent')),
  amount numeric(10,2) not null check (amount >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index surcharges_config_idx on public.pricing_surcharges(pricing_config_id);

create table public.discounts (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  code text unique,
  kind text not null check (kind in ('flat','percent')),
  amount numeric(10,2) not null check (amount > 0),
  is_active boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- CRM: customers, leads, bookings, quotes
-- ---------------------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  -- Normalized columns used to match returning customers and avoid duplicates.
  email_normalized text generated always as (lower(btrim(email))) stored,
  phone_digits text generated always as (nullif(right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 10), '')) stored,
  status text not null default 'active' check (status in ('active','vip','inactive','blocked')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email is not null or phone is not null)
);
create unique index customers_email_uniq on public.customers(email_normalized) where email_normalized is not null;
create index customers_phone_idx on public.customers(phone_digits);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  name text not null,
  email text,
  phone text,
  subject text,
  message text not null,
  source text not null default 'contact_form',
  status text not null default 'new' check (status in ('new','contacted','follow_up','converted','not_interested','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index leads_status_idx on public.leads(status, created_at desc);
create index leads_customer_idx on public.leads(customer_id);

create sequence public.booking_reference_seq start 1001;

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('VT-' || nextval('public.booking_reference_seq')),
  customer_id uuid not null references public.customers(id) on delete restrict,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  tier_id uuid references public.vehicle_tiers(id) on delete set null,
  status text not null default 'new_request' check (status in ('new_request','pending_confirmation','confirmed','assigned','in_progress','completed','cancelled')),
  trip_type text not null check (trip_type in ('distance','hourly')),
  pickup_address text not null,
  dropoff_address text,
  pickup_at timestamptz not null,
  passengers int not null check (passengers > 0),
  hours numeric(5,2),
  distance_miles numeric(10,2),
  duration_minutes int,
  avoid_tolls boolean not null default false,
  estimated_fare_cents int check (estimated_fare_cents is null or estimated_fare_cents >= 0),
  currency text not null default 'USD',
  notes text,
  admin_notes text,
  source_quote_request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bookings_status_idx on public.bookings(status, pickup_at);
create index bookings_customer_idx on public.bookings(customer_id);
create index bookings_pickup_idx on public.bookings(pickup_at);

create table public.booking_stops (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  position int not null,
  address text not null,
  unique (booking_id, position)
);

create table public.quote_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  name text not null,
  email text,
  phone text,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  original_quote_cents int,
  trip jsonb not null default '{}'::jsonb,
  desired_budget_cents int,
  message text,
  status text not null default 'new' check (status in ('new','reviewing','revised_sent','accepted','rejected','closed')),
  revised_price_cents int check (revised_price_cents is null or revised_price_cents >= 0),
  discount_decision text not null default 'pending' check (discount_decision in ('pending','approved','rejected')),
  admin_notes text,
  converted_booking_id uuid references public.bookings(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index quote_requests_status_idx on public.quote_requests(status, created_at desc);

alter table public.bookings
  add constraint bookings_source_quote_fk
  foreign key (source_quote_request_id) references public.quote_requests(id) on delete set null;

-- Immutable record of exactly how each price was calculated.
create table public.pricing_snapshots (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references public.bookings(id) on delete cascade,
  quote_request_id uuid references public.quote_requests(id) on delete cascade,
  pricing_config_id uuid references public.pricing_configs(id) on delete set null,
  snapshot jsonb not null,           -- config + input used
  line_items jsonb not null,         -- breakdown shown to the customer
  total_cents int not null,
  currency text not null default 'USD',
  created_at timestamptz not null default now(),
  check (booking_id is not null or quote_request_id is not null)
);
create index snapshots_booking_idx on public.pricing_snapshots(booking_id);

create table public.crm_notes (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('customer','lead','booking','quote_request')),
  entity_id uuid not null,
  author_id uuid references auth.users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index crm_notes_entity_idx on public.crm_notes(entity_type, entity_id);

create table public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete cascade,
  entity_type text check (entity_type in ('customer','lead','booking','quote_request')),
  entity_id uuid,
  title text not null,
  notes text,
  due_at timestamptz not null,
  completed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index follow_ups_due_idx on public.follow_ups(due_at) where completed_at is null;

-- ---------------------------------------------------------------------------
-- Website content
-- ---------------------------------------------------------------------------
create table public.faqs (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  image_url text,
  cta_text text,
  cta_url text,
  is_active boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  display_frequency text not null default 'once_per_session' check (display_frequency in ('every_visit','once_per_session','once_per_day','once_per_week','once')),
  show_on_mobile boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.site_content (
  key text primary key,
  label text not null,
  group_name text not null default 'general',
  value jsonb not null,
  is_placeholder boolean not null default true,  -- shown as "placeholder" in the dashboard
  updated_at timestamptz not null default now()
);

create table public.vehicle_standards (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Notifications and audit
-- ---------------------------------------------------------------------------
create table public.notification_logs (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('email','sms')),
  event text not null,
  entity_type text,
  entity_id uuid,
  dedupe_key text unique,            -- prevents sending the same alert twice
  status text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  attempts int not null default 0,
  error text,
  provider_response jsonb,
  created_at timestamptz not null default now(),
  last_attempt_at timestamptz
);
create index notification_logs_status_idx on public.notification_logs(status, created_at desc);

create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id uuid,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index activity_logs_created_idx on public.activity_logs(created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['vehicle_categories','vehicle_tiers','vehicles','pricing_configs','discounts','customers','leads','bookings','quote_requests','faqs','promotions','site_content','vehicle_standards']
  loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
