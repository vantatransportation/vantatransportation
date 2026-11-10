-- Vanta upgrade: family-focused booking, round trips, Meet & Greet, contacts, policies,
-- no-show tracking, admin in-dashboard notifications. Run AFTER 0001-0003. Idempotent where practical.
-- Historical data is preserved: notification_logs keeps its 'sms' channel value so old rows stay valid.

-- 1. bookings: new columns and the 'no_show' status ----------------------------------------------
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('new_request','pending_confirmation','confirmed','assigned','in_progress','completed','cancelled','no_show'));

alter table public.bookings
  add column if not exists trip_direction text not null default 'one_way' check (trip_direction in ('one_way','round_trip')),
  add column if not exists booking_for text not null default 'self' check (booking_for in ('self','other')),
  add column if not exists luggage_count int check (luggage_count is null or luggage_count >= 0),
  add column if not exists assistance_notes text,
  add column if not exists pickup_instructions text,
  add column if not exists service_region text not null default 'unknown' check (service_region in ('dmv','east_coast','other','unknown')),
  add column if not exists fulfilment_mode text not null default 'review' check (fulfilment_mode in ('vanta','partner','review')),
  add column if not exists partner_name text,
  add column if not exists requires_manual_review boolean not null default false,
  add column if not exists review_reason text,
  add column if not exists policies_acknowledged_at timestamptz,
  add column if not exists policy_snapshot jsonb,
  add column if not exists waiting_minutes_billed int check (waiting_minutes_billed is null or waiting_minutes_billed >= 0),
  add column if not exists waiting_charge_cents int check (waiting_charge_cents is null or waiting_charge_cents >= 0),
  add column if not exists waiting_charge_status text not null default 'none' check (waiting_charge_status in ('none','pending','invoiced','paid','waived')),
  add column if not exists no_show_at timestamptz,
  add column if not exists no_show_reason text,
  add column if not exists no_show_marked_by uuid references auth.users(id) on delete set null,
  add column if not exists no_show_marked_by_email text,
  add column if not exists no_show_charge_cents int check (no_show_charge_cents is null or no_show_charge_cents >= 0),
  add column if not exists no_show_charge_status text not null default 'none' check (no_show_charge_status in ('none','pending','invoiced','paid','waived'));

-- 2. Journey legs (outbound / return) with their own price snapshot ------------------------------
create table if not exists public.booking_legs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  leg_number int not null check (leg_number in (1,2)),
  direction text not null check (direction in ('outbound','return')),
  pickup_address text not null,
  dropoff_address text,
  stops jsonb not null default '[]'::jsonb,
  pickup_at timestamptz not null,
  distance_miles numeric(10,2),
  duration_minutes int,
  fare_cents int check (fare_cents is null or fare_cents >= 0),
  pricing_snapshot jsonb,
  created_at timestamptz not null default now(),
  unique (booking_id, leg_number)
);

-- 3. People attached to a booking: booker copy, passenger, emergency/secondary contacts ----------
create table if not exists public.booking_people (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  role text not null check (role in ('booker','passenger','emergency_contact','secondary_contact')),
  full_name text not null,
  phone text,
  email text,
  relationship text,
  created_at timestamptz not null default now()
);
create index if not exists booking_people_booking_idx on public.booking_people(booking_id);

-- 4. Airport / Meet & Greet --------------------------------------------------------------------
create table if not exists public.booking_airport_details (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  leg_number int not null default 1,
  airport text not null,
  airline text,
  flight_number text,
  flight_direction text not null check (flight_direction in ('arrival','departure')),
  flight_date date,
  flight_time text,
  terminal text,
  passenger_name text,
  pickup_instructions text,
  meet_greet_requested boolean not null default false,
  meet_greet_status text not null default 'not_requested' check (meet_greet_status in ('not_requested','requested','confirmed','declined')),
  meet_greet_charge_cents int check (meet_greet_charge_cents is null or meet_greet_charge_cents >= 0),
  created_at timestamptz not null default now()
);
create index if not exists booking_airport_booking_idx on public.booking_airport_details(booking_id);

-- 5. Admin-configurable booking settings (single row). Nothing here is an approved price by default.
create table if not exists public.booking_settings (
  id uuid primary key default gen_random_uuid(),
  meet_greet_enabled boolean not null default true,
  meet_greet_charge_cents int check (meet_greet_charge_cents is null or meet_greet_charge_cents >= 0),
  meet_greet_charge_approved boolean not null default false,
  waiting_included_minutes int not null default 15 check (waiting_included_minutes >= 0),
  waiting_increment_minutes int not null default 15 check (waiting_increment_minutes > 0),
  waiting_rate_cents int check (waiting_rate_cents is null or waiting_rate_cents >= 0),
  waiting_rate_approved boolean not null default false,
  partner_fulfilment_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.booking_settings (id) select gen_random_uuid() where not exists (select 1 from public.booking_settings);

-- 6. Round-trip discount rules (none seeded; nothing is active until an admin creates and activates one)
create table if not exists public.round_trip_rules (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  kind text not null check (kind in ('flat','percent')),
  amount numeric(10,2) not null check (amount > 0),
  category_id uuid references public.vehicle_categories(id) on delete set null, -- null = all categories
  is_active boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 7. Quote requests: manual quotes, region, history ----------------------------------------------
alter table public.quote_requests
  add column if not exists source text not null default 'calculator' check (source in ('calculator','manual')),
  add column if not exists service_region text not null default 'unknown' check (service_region in ('dmv','east_coast','other','unknown')),
  add column if not exists revised_history jsonb not null default '[]'::jsonb;

-- 8. In-dashboard admin notifications (also the source for native browser notifications) ---------
create table if not exists public.admin_notifications (
  id uuid primary key default gen_random_uuid(),
  event text not null,
  entity_type text not null,
  entity_id uuid not null,
  title text not null,
  body text not null,
  link text not null,
  dedupe_key text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists admin_notifications_created_idx on public.admin_notifications(created_at desc);

create table if not exists public.admin_notification_reads (
  notification_id uuid not null references public.admin_notifications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);

-- 9. Row Level Security: all new tables are admin-only. Public form data is written by server routes
--    using the service-role key. There are deliberately NO public policies.
do $$
declare t text;
begin
  foreach t in array array['booking_legs','booking_people','booking_airport_details','booking_settings','round_trip_rules','admin_notifications','admin_notification_reads']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "admin full access" on public.%I', t);
    execute format('create policy "admin full access" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

drop trigger if exists set_updated_at on public.booking_settings;
create trigger set_updated_at before update on public.booking_settings for each row execute function public.set_updated_at();
drop trigger if exists set_updated_at on public.round_trip_rules;
create trigger set_updated_at before update on public.round_trip_rules for each row execute function public.set_updated_at();

-- 10. Website content. Policies are publicly readable (group 'Policies'); existing admin edits are kept.
insert into public.site_content (key, label, group_name, value, is_placeholder) values
  ('policy.no_show', 'No-show policy wording', 'Policies', '"If a passenger does not show up for the confirmed pickup, the full applicable trip price may be charged in accordance with the company''s no-show policy. If you cannot locate your driver or need help with pickup arrangements, please contact Vanta right away."', true),
  ('policy.assistance', 'Passenger assistance wording', 'Policies', '"Our drivers aim to provide thoughtful, passenger-conscious service and reasonable assistance throughout your journey, including helping passengers with luggage and getting in and out of the vehicle when reasonably possible."', true),
  ('policy.availability', 'Availability wording', 'Policies', '"You can submit a request at any time. Availability and final confirmation depend on the location, driver or affiliate availability and applicable booking rules."', true),
  ('coverage.primary', 'Coverage: primary focus', 'Coverage', '"Washington, D.C., Maryland and Virginia (the DMV) are our primary focus, including the greater Baltimore area."', true),
  ('coverage.east_coast', 'Coverage: wider East Coast', 'Coverage', '"We also take requests along the East Coast from North Carolina to New York. These trips may be fulfilled by Vanta or by approved transportation partners."', true),
  ('coverage.other', 'Coverage: other destinations', 'Coverage', '"You may request transportation elsewhere in the U.S. and in selected European destinations such as San Francisco, Los Angeles, Chicago, Paris and cities in England. These trips may be arranged through an affiliate network, subject to availability, local requirements and confirmation."', true),
  ('trust.points', 'Family and peace-of-mind points', 'Home', '[{"title":"Rides for the people you care about","description":"Arrange a ride for a parent, child or relative, and tell us who is travelling and who to contact."},{"title":"Passenger-conscious service","description":"Reasonable help with luggage and getting in and out of the vehicle, when reasonably possible."},{"title":"Clear booking information","description":"See your estimate, the waiting-time and no-show policies, and what is requested versus confirmed."},{"title":"Airport transfers and Meet & Greet","description":"Pre-arranged airport rides. Request a driver to meet the passenger inside the airport."}]', true)
on conflict (key) do nothing;

-- Refresh contact details and hero copy only where an admin has not edited them yet.
insert into public.site_content (key, label, group_name, value, is_placeholder) values
  ('contact.phone', 'Public phone', 'Contact', '"+1 443-910-1794"', true),
  ('contact.email', 'Public email', 'Contact', '"vantaholdings.1@gmail.com"', true),
  ('contact.hours', 'Hours', 'Contact', '"24/7 for requests. Transportation availability and final confirmation depend on location and availability."', true),
  ('hero.title', 'Hero heading', 'Home', '"Luxury Transportation. Peace of Mind for Every Journey."', true),
  ('hero.subtitle', 'Hero text', 'Home', '"Premium private rides for families, airport transfers, and everyday travel—with thoughtful service and support for the people who matter most."', true),
  ('hero.cta_primary', 'Hero primary button', 'Home', '"BOOK A RIDE"', true),
  ('hero.cta_secondary', 'Hero secondary button', 'Home', '"GET A QUOTE"', true)
on conflict (key) do update set value = excluded.value where public.site_content.is_placeholder = true;

update public.site_content set label = 'Email customers on every booking status change (confirmed, cancelled and no-show emails are always sent)'
  where key = 'settings.notify_status_changes';
