-- Vanta upgrade 5: admin-controlled hero background slideshow + "Every Passenger Is Family" homepage section.
-- Run AFTER 0001-0010. Forward-only, idempotent and non-destructive: it only CREATES tables/policies and INSERTS content rows
-- that do not exist yet. No existing row, table or column is changed or removed.

-- 1. Slideshow settings: exactly one row (the primary key is a boolean that can only be true).
create table if not exists public.hero_settings (
  id boolean primary key default true check (id),
  autoplay boolean not null default true,
  transition text not null default 'fade' check (transition in ('fade','slide','zoom')),
  fade_ms int not null default 1200 check (fade_ms between 200 and 5000),
  interval_ms int not null default 6000 check (interval_ms between 2000 and 60000),
  overlay_opacity int not null default 55 check (overlay_opacity between 0 and 90),
  pause_on_hover boolean not null default true,
  show_dots boolean not null default false,
  updated_at timestamptz not null default now(),
  check (interval_ms >= fade_ms)
);
insert into public.hero_settings (id) values (true) on conflict (id) do nothing;

-- 2. Slides. Only the Cloudinary URL and public id are stored (never image data).
create table if not exists public.hero_slides (
  id uuid primary key default gen_random_uuid(),
  image_url text not null,
  image_public_id text not null,
  alt_text text,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists hero_slides_order_idx on public.hero_slides(sort_order, created_at);
create index if not exists hero_slides_public_id_idx on public.hero_slides(image_public_id);

drop trigger if exists set_updated_at on public.hero_settings;
create trigger set_updated_at before update on public.hero_settings for each row execute function public.set_updated_at();
drop trigger if exists set_updated_at on public.hero_slides;
create trigger set_updated_at before update on public.hero_slides for each row execute function public.set_updated_at();

-- 3. Row Level Security: admins manage everything; the public can only READ the settings and the ACTIVE slides.
--    There are no public INSERT/UPDATE/DELETE policies (writes go through the admin API with the service-role key).
alter table public.hero_settings enable row level security;
alter table public.hero_slides enable row level security;
drop policy if exists "admin full access" on public.hero_settings;
create policy "admin full access" on public.hero_settings for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin full access" on public.hero_slides;
create policy "admin full access" on public.hero_slides for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "public read hero settings" on public.hero_settings;
create policy "public read hero settings" on public.hero_settings for select to anon, authenticated using (true);
drop policy if exists "public read active hero slides" on public.hero_slides;
create policy "public read active hero slides" on public.hero_slides for select to anon, authenticated using (is_active);

-- 4. Family section copy (editable in Admin, Family section). Existing rows are never overwritten.
--    group_name is 'Home' (public). Do NOT use 'Settings': those rows are hidden from the public site by RLS.
insert into public.site_content (key, label, group_name, value, is_placeholder) values
  ('family_section.enabled', 'Family section: show on home page', 'Home', 'true', false),
  ('family_section.title', 'Family section: heading', 'Home', '"Every Passenger Is Family."', false),
  ('family_section.subtitle', 'Family section: subheading', 'Home', '"We Drive Them Like They''re Our Own."', false),
  ('family_section.body', 'Family section: paragraph', 'Home', '"We believe every passenger deserves the care and attention we''d give our own loved ones. Whether we''re transporting someone''s grandparents, parents, siblings, or children, we approach every journey with patience, respect, responsibility, and an unwavering commitment to their safety."', false),
  ('family_section.closing', 'Family section: closing line', 'Home', '"Because someone is waiting for them at the other end."', false),
  ('family_section.image', 'Family section: image', 'Home', '{"url":"","publicId":"","alt":""}', false)
on conflict (key) do nothing;
