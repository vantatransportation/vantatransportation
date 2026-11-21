# Fleet cards show "Photo coming soon" while Calculate Your Fare shows the photo

## Root cause
Calculate Your Fare and the public fleet cards use the same `VehiclePhoto` component, the same `resolvePhotoSrc()` and the
same Next image settings, so the image handling is not the difference. The difference is how each one LOADS the vehicles:

* Calculator: `/api/fare/quote` -> `loadFleet()` -> service-role client, one query for vehicles, fresh on every request.
* Home "Our Fleet", category tiles and `/rides`: `getSiteData()` -> anonymous (publishable) key, in ONE `Promise.all` together with
  categories, standards, FAQs and site content. If ANY of those reads failed, or the anon key was missing/invalid, the function
  returned `defaultSiteData` for everything. The built-in default vehicles have `image: null`, so every card rendered the
  branded "Photo coming soon" placeholder. A missing anon key returned the defaults with no log line at all.

Saving was correct (Cloudinary URL + public id persisted; site revalidated by the previous fix), which is why the calculator,
which never touches that path, kept showing the photo.

Secondary hardening: `VehiclePhoto` relied on `onError`, which is not delivered for a server-rendered `<img>` that fails
before React hydrates; the calculator (mounted in the browser) never had that gap.

## Changes
* `src/lib/fleet-data.ts` (new, pure): explicit column lists, row mappers, `pickCategoryVehicle()`.
* `src/lib/content.ts`: new `loadFleetData()` reads categories + vehicles with the service-role client first (same access as the
  calculator), then the anon client; visibility rules (`is_active`, inactive tier/category) are applied explicitly because the
  service role bypasses RLS. Failures are logged and no longer take FAQs/standards/content (or the photos) down with them.
  A missing anon key is now logged. Other public content (FAQs, standards, site content, promotion) still uses the anon key and RLS.
* `src/components/Sections.tsx`: category tiles use `pickCategoryVehicle()` (bookable vehicle with a real photo first).
* `src/components/VehiclePhoto.tsx`: an image that already failed before hydration moves to the next fallback stage.
* `tests/fleet-photos.test.ts` (new), `tests/integration/stubs/supabase.mjs` (per-key test database).

## Not changed
Database, RLS, migrations, admin save route, revalidation, `resolvePhotoSrc()`, `next.config.ts`, calculator, pricing, payments.
No SQL is required.

## Verify after deploy
Vercel > Logs, open the home page and look for `[site] fleet loaded via service client: N vehicle(s), M with a real photo`.
`[site] fleet read failed ...` or `NEXT_PUBLIC_SUPABASE_ANON_KEY missing` names the real environment problem.
