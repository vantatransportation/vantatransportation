# Hero slideshow and "Every Passenger Is Family." section

## 1. Apply the migration (once)

File: `supabase/migrations/0011_hero_slideshow_family_section.sql`

Supabase dashboard, SQL editor, paste the file, Run. It is forward-only and idempotent: it only creates two tables
(`hero_settings`, `hero_slides`), their RLS policies and indexes, and inserts the six `family_section.*` content rows with
`on conflict do nothing`. It changes and deletes nothing that exists. Do not re-run earlier migrations or the seed.
Run it after `0010` (multi-tier vehicles); see docs/MULTI_TIER_VEHICLES.md.

Until it is applied the website works exactly as before (original hero, family section from built-in text) and
Admin, Hero slideshow shows a message asking you to apply it.

## 2. Environment variables

None new. Uploads use the existing `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `NEXT_PUBLIC_CLOUDINARY_API_KEY` and
`CLOUDINARY_API_SECRET` (the secret stays on the server; the browser only receives a short-lived signature).

Cloudinary: nothing to create manually. Two new folders appear on the first upload: `vanta/hero` (slideshow images) and
`vanta/site` (family-section image). Vehicle photos stay in `vanta/vehicles`.

## 3. Hero slideshow (Admin, Hero slideshow)

* Upload images (JPG, PNG, WebP, up to 8 MB, max 12 images). Wide landscape photos of at least 1920 px work best.
* Per image: replace, disable/enable, remove (asset is deleted from Cloudinary only when nothing else uses it), description for screen readers.
* Reorder by dragging or with the arrows. Images play top to bottom.
* Settings: play automatically, transition (fade, slide, fade with slow zoom), fade duration (200-5000 ms), time each image stays visible (2000-60000 ms, not shorter than the fade), overlay darkness (0-90), pause on hover, navigation dots.
* A live preview uses the same component as the website and reflects unsaved settings.
* Saving refreshes the public pages immediately; no code change or redeploy.

Behaviour on the site:

* No active images, migration not applied, or a read error: the original gradient hero is shown, unchanged.
* The hero heading, subheading, both buttons, trip form and Vanta mark are untouched; the photos are an absolutely positioned background layer, so nothing shifts.
* Over photographs the hero uses the dark colour palette in both themes, with a left-to-right dark overlay, so text stays readable.
* Only the first image is in the server-rendered HTML (high fetch priority). Each next image is preloaded (same `srcset`/`sizes`) just before it is shown; images that fail to load are skipped.
* Images are delivered through Cloudinary (`f_auto,q_auto,c_limit`, widths 640/1280/1920). There is one responsive image per slide; separate mobile images are not used.
* Autoplay stops for visitors who prefer reduced motion (they see the first image, still), while the browser tab is hidden, and (optionally) while the pointer is over the hero. A single image never starts a timer.

## 3a. Family section (Admin, Family section)

Heading, subheading, paragraph, closing line, image and an on/off switch. The section sits right after "Thoughtful rides for
the people who matter most" on the home page. It is a dark bordered card: image above centred text on phones, image beside
text from tablet width up. The default copy is the approved text. Without an uploaded image a branded panel with the Vanta mark
is shown. The reference photo was **not** included because it carries a third-party watermark (mnmridez.com): upload a photo you
own or are licensed to use.

## 4. Verify after deploying

1. Admin, Hero slideshow: upload two images, Save settings, open the home page in a private window: first image shows, second fades in after the chosen time.
2. Disable both images: the home page shows the original hero.
3. Admin, Family section: upload an image, save, reload the home page.
4. Check the home page in light and dark theme and on a phone width.

## 5. Family section data path (reference)

Admin form -> `POST /api/admin/family` (one atomic upsert of the six `family_section.*` rows in `site_content`, group "Home",
verified against what the database returns, then the site is revalidated) -> public home page reads the same six rows with
`loadFamilyContent()` (service-role client, anon fallback) -> `buildFamilyView()` -> `FamilySection`. See FIX_NOTES_FAMILY_SECTION.md.
