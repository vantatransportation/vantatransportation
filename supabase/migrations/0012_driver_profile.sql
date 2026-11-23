-- 0012: simplified driver profile (additive and backward compatible; no data is dropped or rewritten destructively).
-- Run AFTER 0011. Safe to run more than once.
--
-- Existing columns are reused:   full_name (kept, now derived: first + last name), vehicle_plate (= License Plate),
--                                vehicle_description (kept, now derived: "year make model").
-- New columns:                   first_name, last_name, preferred_name, vehicle_year, vehicle_make, vehicle_model,
--                                location, preferred_area, image_url + image_public_id (Cloudinary driver picture).
-- The driver's phone column is left untouched (existing data is preserved) but is no longer collected or shown.

alter table public.drivers
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists preferred_name text,
  add column if not exists vehicle_year integer,
  add column if not exists vehicle_make text,
  add column if not exists vehicle_model text,
  add column if not exists location text,
  add column if not exists preferred_area text,
  add column if not exists image_url text,
  add column if not exists image_public_id text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'drivers_vehicle_year_range') then
    alter table public.drivers add constraint drivers_vehicle_year_range check (vehicle_year is null or (vehicle_year between 1980 and 2100));
  end if;
end $$;

-- Backfill ONLY rows that have no first name yet: the first word of full_name becomes the first name, the rest the last name.
-- full_name itself is not changed, so existing assignments, emails and history keep working.
update public.drivers
   set first_name = nullif(split_part(trim(full_name), ' ', 1), ''),
       last_name  = nullif(trim(substr(trim(full_name), length(split_part(trim(full_name), ' ', 1)) + 1)), '')
 where first_name is null;

-- Admin chat monitoring needs no schema change: booking_messages (0008) already has an (booking_id, created_at) index and an admin-only policy.
