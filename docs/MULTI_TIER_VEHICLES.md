# Multi-tier vehicles (one vehicle, several tiers)

## What changed
* New table `vehicle_tier_assignments` (vehicle_id, tier_id, unique pair, cascade FKs, RLS). It is the source of truth.
* `vehicles.tier_id` is DEPRECATED but kept. On every admin save the vehicle's first tier is mirrored into it, so you can roll back the app without data loss.
* Admin: the vehicle form has a tier multi-select. Vehicles with no tier are not shown in the calculator (as before).
* Calculator/booking: a vehicle appears in each assigned tier and only those. The customer picks a tier; the server validates the vehicle/tier pair (422 if invalid; a single-tier vehicle auto-uses its tier).
* Pricing: trip estimate is per vehicle (pricing_configs); online charge (tier fixed price, Meet & Greet fee) is per selected tier. A tier without a price shows "Price to be confirmed". No prices are invented.
* Old bookings keep their snapshot (tier_id, tier_name, fixed_price_cents) and render unchanged.
* Tier names in this project are Premium / Luxury / Luxury Plus (not "Super Luxury").

## Apply safely (existing database)
1. Back up (Supabase > Database > Backups).
2. SQL editor: run `supabase/migrations/0010_vehicle_tier_assignments.sql`, then `0011_hero_slideshow_family_section.sql`. Each only creates objects, copies links and `on conflict do nothing`.
3. Do NOT re-run 0001-0009 or `seed.sql`. Nothing is truncated or deleted.
4. Verify: `select count(*) from vehicle_tier_assignments;` equals the number of vehicles with a tier_id.
5. Deploy the app (Vercel), then in Admin > Vehicles assign extra tiers.

## Environment variables
No new variables. Existing Cloudinary and Supabase variables are reused; the service-role key stays server-side.

## Rollback
Redeploy the previous app build; `vehicles.tier_id` still holds each vehicle's first tier. Drop the old column only in a later migration.
