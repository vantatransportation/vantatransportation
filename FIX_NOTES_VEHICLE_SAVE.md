# Vehicle photo / edit not showing on the live site

## Root cause
Admin saves were reaching the database, but the public site never found out:
1. Public pages (`/`, `/rides`, `/about`, `/quote`, layout) use `export const revalidate = 60` (ISR) and **no admin save ever revalidated them**. Visitors kept getting the cached HTML (old photo/values), refreshed only on a 60 s timer and only after a visit triggered regeneration, so changes looked random.
2. `getSiteData()` silently returned the built-in defaults (no photos, hardcoded vehicles) on any Supabase read error, so a failed read looked like "my edit did not save". Errors are now logged.
3. The admin update did not verify a row was written (`update().eq()` with no returned row).

Upload itself (Cloudinary, signed direct upload) and the `image_url` / `image_public_id` columns were correct; no schema, RLS, bucket or env changes are needed.

## Changes
- `src/lib/admin/revalidate.ts` (new): `revalidateSite()` -> `revalidatePath("/", "layout")`; list of public tables.
- `src/app/api/admin/crud/route.ts`: update now returns the written row; no row -> 409 (no false success); vehicle `image_url` verified against what was stored; revalidates the site after create/update/delete/move on public tables (vehicles, categories, tiers, standards, FAQs, promotions, site content); move/log errors surfaced and logged.
- `src/app/api/admin/content/route.ts`: same verify + revalidate for website text edits.
- `src/lib/content.ts`: logs Supabase read failures instead of silently using defaults.
- `src/components/VehiclePhoto.tsx`: now a client component; if an image fails to load, shows the branded placeholder instead of a broken image.
- `tests/integration/loader.mjs`, `tests/workflow.test.ts`: `next/cache` stub + regression test (90/90 pass).
Stripe, PayPal, pricing, booking, auth and RLS untouched.

## Deploy
1. Deploy this code to Vercel (no new env vars, no migrations).
2. Confirm in Vercel env: `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `NEXT_PUBLIC_CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`. `NEXT_PUBLIC_*` values are baked in at build, so redeploy after changing them.
3. Test: admin > Vehicles > Edit > Upload this photo > **Save changes** (the photo only publishes on Save) > reload `/` and `/rides`; it should appear immediately.
4. If a vehicle is unticked "Shown on website", RLS hides it from the public by design.
5. Check Vercel > Logs for `[site] Supabase read failed`; it would point to a missing column/migration (e.g. `0005` adds `image_public_id`, apply it if not run).
