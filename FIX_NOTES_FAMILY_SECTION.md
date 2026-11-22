# Family section: admin edits (image and text) not showing on the public site

## What was found
The Family section (`family_section.*` rows in `site_content`) is written by `POST /api/admin/family` and shown by
`FamilySection` on the home page. Reading the code, the field names, keys, Cloudinary folder rules and revalidation all
line up, and the existing tests passed. The weak point was HOW THE PUBLIC PAGE READ the saved rows, and how the save wrote them:

1. **Public read was all-or-nothing and went through the anonymous key.** `getSiteData()` reads site content, FAQs and
   standards with the anon key in one `Promise.all` and returns the built-in defaults for EVERYTHING if any read fails, if the
   anon key is missing, or if RLS hides a row. For the Family section the defaults are exactly the symptom reported: the old
   copy and the Vanta mark, even though the admin page (service-role client) shows the saved values. This is the same failure
   that was fixed for fleet photos (`FIX_NOTES_FLEET_PHOTOS.md`); the Family section had been left on the old path.
2. **Rows in the "Settings" group are invisible to the public.** RLS (`public read site content`) excludes
   `group_name = 'Settings'`. The old save only UPDATED existing rows and never touched `group_name`, so a Family row that
   was ever stored in that group would show in Admin but never publicly, and saving did not repair it.
3. **The save was six separate writes** (update, then insert if missing, one key at a time). A failure part-way left text and
   image out of step, and success was reported without checking what the database stored.
4. A value stored as a JSON *string* (e.g. `'{"url":...}'` or `'false'`) was ignored by the public view while the admin form
   (same row) looked fine.

I could not reach the live Supabase project from here, so I cannot say which of 1, 2 or 4 is what your production database
is doing. The fix closes all of them, and the new log lines (below) tell you which one it was.

## Changes
* `src/lib/family-data.ts` (new): `loadFamilyContent()` reads only the six Family rows, with the service-role client first, then
  the anon client; logs the client used, rows hidden by RLS, and read failures. `readFamilyRows()` is shared with the admin page.
* `src/app/(site)/page.tsx`: the Family view is built from `loadFamilyContent()` (one line). `revalidate = 60` unchanged.
* `src/app/api/admin/family/route.ts`: one atomic `upsert` of the six rows, always `group_name = 'Home'`; success is only
  reported when the database returns the stored rows and they match; returns `revalidated` and the stored values.
* `src/app/admin/(panel)/family/page.tsx`: reads through `readFamilyRows()` (exact key list instead of `LIKE`).
* `src/components/admin/FamilyEditor.tsx`: shows the values the database stored after saving, keeps the "Saved" message
  (the form is no longer remounted by a `key`), and says so if the site refresh could not be triggered.
* `src/lib/family-section.ts`: string-encoded JSON for image / switch is read as intended.
* Tests: `tests/family-pipeline.test.ts` (new, 11 tests); `tests/integration/fakedb.mjs` gained a real `upsert(..., {onConflict})`
  and a write-failure switch (test infrastructure only).

## Not changed
No SQL migration is required and none was added. No tables, rows, payments, bookings, drivers, chat, pricing, auth or other
sections were touched. The V mark remains the fallback only when no image is configured. The Family section has no buttons in
this codebase; its editable fields are the on/off switch, heading, subheading, paragraph, closing line, image and image description.

## After deploying
1. Admin, Family section: change the heading, Save. The message says the home page shows the change now.
2. Vercel logs for `/`: look for `[site] family section loaded via service client: N/6 stored values`.
   * `family section read failed via ... client` names the real read problem (key, URL, table).
   * `family section rows are hidden from public reads (group_name "Settings")` means cause 2; one save repairs it.
3. Optional one-off clean-up (only if you want to repair rows without saving): 
   `update public.site_content set group_name = 'Home' where key in ('family_section.enabled','family_section.title','family_section.subtitle','family_section.body','family_section.closing','family_section.image') and group_name <> 'Home';`
