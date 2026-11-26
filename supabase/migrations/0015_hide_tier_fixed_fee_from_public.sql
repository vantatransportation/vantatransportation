-- 0015: keep the internal tier fixed/base fee out of reach of customers.
--
-- Why: the original 0002 policy "public read active tiers" lets the anonymous (and any signed-in) Supabase role read EVERY column of
-- public.vehicle_tiers through the public REST API, including fixed_price_cents. Customers must only ever see one combined Trip Fare.
--
-- What this does (additive, idempotent, no data is changed or deleted):
--   * revokes table-wide SELECT on vehicle_tiers from the anon and authenticated roles;
--   * grants them SELECT on every column EXCEPT fixed_price_cents (so the public tier name/description/Meet & Greet fee keep working
--     exactly as before; the Meet & Greet fee is a separately displayed service fee, not an internal fee).
-- The website, the admin dashboard and all API routes use the server-side service-role key, which is unaffected (it bypasses RLS and
-- column grants). Nothing in this application reads vehicle_tiers with the anon key.
--
-- Rollback (restores the old, leaky behaviour; only if you know you need it):
--   grant select on public.vehicle_tiers to anon, authenticated;

revoke select on public.vehicle_tiers from anon, authenticated;

do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'vehicle_tiers' and column_name <> 'fixed_price_cents';
  if cols is not null then
    execute format('grant select (%s) on public.vehicle_tiers to anon, authenticated', cols);
  end if;
end $$;
