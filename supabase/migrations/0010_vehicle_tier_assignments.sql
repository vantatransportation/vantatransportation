-- Vanta upgrade 4: one vehicle can be offered in several service tiers (many-to-many).
-- Run AFTER 0001-0009, and BEFORE 0011. Forward-only, idempotent and NON-DESTRUCTIVE:
--   * it only CREATES one table (with its constraints, indexes and RLS policies), COPIES the existing vehicle -> tier links
--     into it, and adds a column COMMENT;
--   * it does not drop, rename, truncate or rewrite anything. `vehicles.tier_id` stays exactly as it is (see section 4);
--   * bookings, payments, pricing configs, tier prices and Meet & Greet fees are not touched.
-- Safe to run more than once (every statement is guarded). Do NOT re-run earlier migrations or the seed.

-- 1. The join table: ONE canonical vehicles row per vehicle, one row here per (vehicle, tier) it is offered in.
--    Both foreign keys cascade: the rows are pure links, so deleting a vehicle removes its links and nothing else.
create table if not exists public.vehicle_tier_assignments (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  tier_id uuid not null references public.vehicle_tiers(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- A vehicle can be assigned to a tier only once.
  constraint vehicle_tier_assignments_unique unique (vehicle_id, tier_id)
);
-- Lookups: "which tiers does this vehicle have" is served by the unique index (vehicle_id first);
-- "which vehicles are in this tier" needs its own index.
create index if not exists vehicle_tier_assignments_tier_idx on public.vehicle_tier_assignments (tier_id, vehicle_id);

-- 2. Backfill from the current single-tier relationship. Vehicles without a tier get no row (they stay untiered, as before).
insert into public.vehicle_tier_assignments (vehicle_id, tier_id)
  select v.id, v.tier_id from public.vehicles v where v.tier_id is not null
  on conflict (vehicle_id, tier_id) do nothing;

-- 3. Safety check. If any existing vehicle -> tier link was NOT carried over, stop with an error. When the script runs as one
--    statement batch (the Supabase SQL editor does this) the whole migration is rolled back and nothing has changed.
do $$
declare missing int;
begin
  select count(*) into missing
    from public.vehicles v
    where v.tier_id is not null
      and not exists (select 1 from public.vehicle_tier_assignments a where a.vehicle_id = v.id and a.tier_id = v.tier_id);
  if missing > 0 then
    raise exception 'Migration 0010 aborted: % vehicle tier link(s) were not backfilled. Nothing was removed.', missing;
  end if;
end $$;

-- 4. The old column is deliberately KEPT (its data is the rollback copy; the app stops treating it as the source of truth and
--    only mirrors a vehicle's first tier into it). Drop it in a LATER migration, once you no longer need to roll back.
comment on column public.vehicles.tier_id is 'DEPRECATED. Source of truth is public.vehicle_tier_assignments. The app mirrors the vehicle''s first tier here for rollback safety only.';

-- 5. Row Level Security. Admins manage everything. The public can only READ links between an ACTIVE vehicle and an ACTIVE tier
--    (the same visibility rules as vehicles and vehicle_tiers). There are no public INSERT/UPDATE/DELETE policies: writes go
--    through the admin API with the service-role key, which stays on the server.
alter table public.vehicle_tier_assignments enable row level security;
drop policy if exists "admin full access" on public.vehicle_tier_assignments;
create policy "admin full access" on public.vehicle_tier_assignments for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "public read active tier assignments" on public.vehicle_tier_assignments;
create policy "public read active tier assignments" on public.vehicle_tier_assignments for select to anon, authenticated using (
  exists (select 1 from public.vehicles v where v.id = vehicle_id and v.is_active)
  and exists (select 1 from public.vehicle_tiers t where t.id = tier_id and t.is_active)
);
