-- 0013: Phase 2 (dispatch window, ratings, performance points). Additive and backward compatible; safe to run more than once. Run AFTER 0012.

-- 1. Leave-for-pickup dispatch window (minutes before pickup), a temporary admin-editable rule (default 240). Stored on the existing booking_settings row so it can be changed without a redeploy.
alter table public.booking_settings add column if not exists driver_dispatch_window_minutes integer not null default 240;

-- 2. Per-driver performance fields. Points are separate from star ratings (never derived from them).
--    Both are HIDDEN from the driver by default until an admin turns them on. Hiding never deletes data.
alter table public.drivers
  add column if not exists performance_points integer not null default 100,
  add column if not exists show_rating_to_driver boolean not null default false,
  add column if not exists show_points_to_driver boolean not null default false;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'drivers_points_range') then
    alter table public.drivers add constraint drivers_points_range check (performance_points between 0 and 100);
  end if;
end $$;

-- 3. Customer -> driver star ratings: one per booking, enforced by the database as well as the API.
create table if not exists public.driver_ratings (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id) on delete restrict,
  driver_id uuid not null references public.drivers(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete set null,
  stars smallint not null check (stars between 1 and 5),
  feedback text check (feedback is null or char_length(feedback) <= 1000),
  created_at timestamptz not null default now()
);
create index if not exists driver_ratings_driver_idx on public.driver_ratings(driver_id, created_at);

-- 4. Driver -> customer ratings: separate table, internal (admin-only), one per booking.
create table if not exists public.customer_ratings (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id) on delete restrict,
  driver_id uuid not null references public.drivers(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  stars smallint not null check (stars between 1 and 5),
  feedback text check (feedback is null or char_length(feedback) <= 1000),
  created_at timestamptz not null default now()
);
create index if not exists customer_ratings_customer_idx on public.customer_ratings(customer_id, created_at);

-- 5. Append-only history of admin point adjustments.
create table if not exists public.driver_points_history (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id) on delete restrict,
  previous_points integer not null check (previous_points between 0 and 100),
  new_points integer not null check (new_points between 0 and 100),
  adjustment integer not null,
  reason text,
  admin_user_id uuid,
  admin_email text,
  created_at timestamptz not null default now()
);
create index if not exists driver_points_history_driver_idx on public.driver_points_history(driver_id, created_at);

-- 6. RLS: only admins read these through the normal client. The app writes through the service role on the server,
--    after checking the booking, role and eligibility. Nothing here is readable by anonymous or driver sessions.
alter table public.driver_ratings enable row level security;
alter table public.customer_ratings enable row level security;
alter table public.driver_points_history enable row level security;
drop policy if exists "admin full access" on public.driver_ratings;
create policy "admin full access" on public.driver_ratings for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin full access" on public.customer_ratings;
create policy "admin full access" on public.customer_ratings for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin full access" on public.driver_points_history;
create policy "admin full access" on public.driver_points_history for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 7. Tier descriptions for the price-free tier cards. ONLY rows still carrying the original seed text are updated; admin edits are kept.
--    Wording is limited to what the client described for the top tier. Confirm it matches the real service, or edit it under Tiers.
update public.vehicle_tiers set description = 'Our highest service tier: premium luxury vehicles with executive-style seating and a professional chauffeur.'
  where slug = 'luxury-plus' and description = 'Our highest service tier.';
