-- 0007: approve-then-pay workflow, drivers and assignments, status history, luggage, tips and rush-hour surcharge.
-- ADDITIVE AND IDEMPOTENT. Run AFTER 0001-0006. Nothing is dropped or reset; existing bookings keep their data.
-- Backfill notes are at the bottom. Review them before running in production.

-- 1. Booking statuses: adds the driver workflow steps and 'rejected'. Existing values stay valid.
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check check (status in (
  'new_request','pending_confirmation','confirmed','assigned','getting_ready','on_the_way','arrived','picked_up',
  'in_progress','completed','cancelled','rejected','no_show'));

-- 2. Drivers. user_id links to a Supabase Auth account (created in a later phase); nullable until then.
create table if not exists public.drivers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  full_name text not null check (length(trim(full_name)) >= 2),
  email text not null,
  phone text,
  vehicle_plate text,
  vehicle_description text,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists drivers_email_lower_idx on public.drivers (lower(email));

-- 3. Booking columns.
alter table public.bookings
  add column if not exists driver_id uuid references public.drivers(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid,
  add column if not exists rejected_at timestamptz,
  add column if not exists rejection_reason text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancellation_reason text,
  -- Payment may be started only after approval AND driver assignment. Null = not released.
  add column if not exists payment_released_at timestamptz,
  add column if not exists checked_bags int check (checked_bags is null or (checked_bags >= 0 and checked_bags <= 50)),
  add column if not exists carry_on_bags int check (carry_on_bags is null or (carry_on_bags >= 0 and carry_on_bags <= 50)),
  add column if not exists tip_kind text not null default 'none' check (tip_kind in ('none','percent','custom')),
  add column if not exists tip_percent numeric(5,2),
  add column if not exists tip_cents int not null default 0 check (tip_cents >= 0),
  add column if not exists rush_surcharge_percent numeric(5,2),
  add column if not exists rush_surcharge_cents int not null default 0 check (rush_surcharge_cents >= 0),
  add column if not exists terms_acknowledged_at timestamptz;
create index if not exists bookings_driver_idx on public.bookings(driver_id, pickup_at);

-- 4. Assignment history. At most ONE active assignment per booking (database-enforced, safe under concurrent attempts).
create table if not exists public.booking_assignments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete restrict,
  assigned_by uuid,
  assigned_at timestamptz not null default now(),
  unassigned_at timestamptz,
  unassigned_reason text
);
create unique index if not exists booking_one_active_assignment on public.booking_assignments(booking_id) where unassigned_at is null;
create index if not exists booking_assignments_driver_idx on public.booking_assignments(driver_id);

-- 5. Status history (audit trail).
create table if not exists public.booking_status_history (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_type text not null check (actor_type in ('admin','driver','customer','system')),
  actor_id uuid,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists booking_status_history_idx on public.booking_status_history(booking_id, created_at);

-- 6. Rush-hour settings (single settings row). Initial requested rule: 5%, 8-10 AM and 4-6 PM. All editable in Admin.
alter table public.booking_settings
  add column if not exists rush_enabled boolean not null default true,
  add column if not exists rush_percent numeric(5,2) not null default 5 check (rush_percent >= 0 and rush_percent <= 100),
  add column if not exists rush_windows jsonb not null default '[{"start":"08:00","end":"10:00"},{"start":"16:00","end":"18:00"}]'::jsonb,
  add column if not exists rush_timezone text not null default 'America/New_York';

-- 7. RLS: new tables are admin-only. Drivers and customers reach their own rows ONLY through server routes that
--    verify ownership (service role). No policy grants them direct table access here, so a driver querying Supabase
--    directly sees nothing. Direct-access policies (with a safe column view) arrive with driver sign-in.
do $$
declare t text;
begin
  foreach t in array array['drivers','booking_assignments','booking_status_history'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "admin full access" on public.%I', t);
    execute format('create policy "admin full access" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;
drop trigger if exists set_updated_at on public.drivers;
create trigger set_updated_at before update on public.drivers for each row execute function public.set_updated_at();

-- 8. Contact email. Updates the public email ONLY where it is still the previous placeholder (admin edits are kept).
update public.site_content set value = '"vantatransportation.1@gmail.com"' where key = 'contact.email' and value = '"vantaholdings.1@gmail.com"'::jsonb;

-- BACKFILL / EXISTING DATA
--  * Existing bookings keep their status. Bookings already 'assigned' or 'confirmed' before this migration have no driver_id
--    and no payment_released_at; their payment links (if any were already sent) would stop working. To keep a specific
--    existing booking payable, run once per booking:  update public.bookings set payment_released_at = now() where reference = 'VT-XXXX';
--  * Nothing is auto-released: that is a business decision.
