-- Row Level Security.
-- Model: the public (anon) role can only READ published website content.
-- Everything else (customers, bookings, pricing, notifications...) is admin-only.
-- Public form submissions are written by server API routes using the service-role
-- key, which bypasses RLS. There are deliberately NO public INSERT policies.

do $$
declare t text;
begin
  foreach t in array array[
    'admin_users','vehicle_categories','vehicle_tiers','vehicles','pricing_configs','pricing_surcharges',
    'discounts','customers','leads','bookings','booking_stops','quote_requests','pricing_snapshots',
    'crm_notes','follow_ups','faqs','promotions','site_content','vehicle_standards',
    'notification_logs','activity_logs']
  loop
    execute format('alter table public.%I enable row level security', t);
    -- Admins can do everything on every table.
    execute format('create policy "admin full access" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- Public read access to published website content only.
create policy "public read active categories" on public.vehicle_categories for select to anon, authenticated using (is_active);
create policy "public read active tiers"      on public.vehicle_tiers      for select to anon, authenticated using (is_active);
create policy "public read active vehicles"   on public.vehicles           for select to anon, authenticated using (is_active);
create policy "public read active faqs"       on public.faqs               for select to anon, authenticated using (is_active);
create policy "public read active standards"  on public.vehicle_standards  for select to anon, authenticated using (is_active);
create policy "public read site content"      on public.site_content       for select to anon, authenticated using (group_name <> 'Settings');
create policy "public read live promotions"   on public.promotions         for select to anon, authenticated using (
  is_active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at >= now())
);

-- Storage bucket for vehicle and promotion images: public read, admin write.
insert into storage.buckets (id, name, public) values ('site-images', 'site-images', true)
on conflict (id) do nothing;

create policy "public read site images" on storage.objects for select to anon, authenticated using (bucket_id = 'site-images');
create policy "admin write site images" on storage.objects for insert to authenticated with check (bucket_id = 'site-images' and public.is_admin());
create policy "admin update site images" on storage.objects for update to authenticated using (bucket_id = 'site-images' and public.is_admin());
create policy "admin delete site images" on storage.objects for delete to authenticated using (bucket_id = 'site-images' and public.is_admin());
