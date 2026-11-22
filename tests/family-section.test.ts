// "Every Passenger Is Family." section: view model, defaults, admin API, content-API guard, and source checks.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-ignore: plain JS helper
import { FakeDb } from "./integration/fakedb.mjs";
import { FAMILY_DEFAULTS, buildFamilyInput, buildFamilyView, validateFamilyInput } from "../src/lib/family-section.ts";

const db: any = new FakeDb();
const CLOUD = "democloud";
const imgUrl = (n: string) => `https://res.cloudinary.com/${CLOUD}/image/upload/v1/vanta/site/${n}.jpg`;
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const original = { ...process.env };
let familyApi: any, contentApi: any;
let n = 0;
const post = (route: any, body: object) => route.POST(new Request("http://site.test/api/admin/x", { method: "POST", headers: { "content-type": "application/json", origin: "http://site.test", "x-forwarded-host": "site.test", "x-forwarded-for": `10.7.0.${++n}` }, body: JSON.stringify(body) }));
const good = { enabled: true, title: "Every Passenger Is Family.", subtitle: "We Drive Them Like They're Our Own.", body: "Body text.", closing: "Closing.", image: { url: "", publicId: "", alt: "" } };

before(async () => {
  (globalThis as any).__fakeDb = db;
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "http://fake", SUPABASE_SERVICE_ROLE_KEY: "svc", NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: CLOUD, NEXT_PUBLIC_CLOUDINARY_API_KEY: "1", CLOUDINARY_API_SECRET: "s" });
  db.seed("admin_users", [{ user_id: "admin-1", email: "a@x.com" }]);
  familyApi = await import("../src/app/api/admin/family/route.ts");
  contentApi = await import("../src/app/api/admin/content/route.ts");
});
beforeEach(() => { (globalThis as any).__cookies = { vt_at: "good" }; (globalThis as any).__revalidated = 0; });
test.after?.(() => { process.env = original; });

test("without any stored content the section renders the approved copy and a branded (image-less) panel", () => {
  const v = buildFamilyView({})!;
  assert.equal(v.title, "Every Passenger Is Family.");
  assert.equal(v.subtitle, "We Drive Them Like They're Our Own.");
  assert.ok(v.body.startsWith("We believe every passenger deserves the care and attention we'd give our own loved ones."));
  assert.ok(v.body.endsWith("an unwavering commitment to their safety."));
  assert.equal(v.closing, "Because someone is waiting for them at the other end.");
  assert.equal(v.image, null);
});

test("stored text and image override the defaults; the switch hides the section", () => {
  const v = buildFamilyView({ "family_section.title": "Custom", "family_section.image": { url: imgUrl("fam"), publicId: "vanta/site/fam", alt: "Family at the car" } })!;
  assert.equal(v.title, "Custom");
  assert.ok(v.image!.src.includes("/upload/f_auto,q_auto,c_fill,g_auto,w_1200,h_750/") && v.image!.srcSet.includes("640w") && v.image!.alt === "Family at the car");
  assert.equal(buildFamilyView({ "family_section.enabled": false }), null);
  assert.equal(buildFamilyView({ "family_section.image": { url: "javascript:alert(1)" } })!.image, null);
  assert.equal(buildFamilyView({ "family_section.title": "   " })!.title, FAMILY_DEFAULTS.title);
});

test("the admin form is pre-filled from stored values and defaults", () => {
  const i = buildFamilyInput({});
  assert.deepEqual([i.enabled, i.title, i.image.url], [true, FAMILY_DEFAULTS.title, ""]);
});

test("validation: heading required, images only from our Cloudinary site folder, control characters stripped", () => {
  assert.equal(validateFamilyInput({ ...good, title: "  " }, CLOUD).ok, false);
  assert.equal(validateFamilyInput({ ...good, image: { url: "https://evil.example/a.jpg", publicId: "vanta/site/a", alt: "" } }, CLOUD).ok, false);
  assert.equal(validateFamilyInput({ ...good, image: { url: imgUrl("a"), publicId: "vanta/hero/a", alt: "" } }, CLOUD).ok, false);
  assert.equal(validateFamilyInput({ ...good, image: { url: imgUrl("a"), publicId: "vanta/site/a", alt: "ok" } }, CLOUD).ok, true);
  const r = validateFamilyInput({ ...good, title: "A\u0000B" }, CLOUD);
  assert.ok(r.ok && r.data.title === "AB");
});

test("admin API saves text, switch and image, refreshes the site, rejects bad input and unauthenticated calls", async () => {
  (globalThis as any).__cookies = {};
  assert.equal((await post(familyApi, { content: good })).status, 401);
  (globalThis as any).__cookies = { vt_at: "good" };
  assert.equal((await post(familyApi, { content: { ...good, title: "" } })).status, 422);
  assert.equal((await post(familyApi, { content: { ...good, image: { url: "https://evil.example/a.jpg", publicId: "x", alt: "" } } })).status, 422);
  assert.equal(db.t("site_content").length, 0, "nothing is written when validation fails");

  const res = await post(familyApi, { content: { ...good, title: "New heading", image: { url: imgUrl("a"), publicId: "vanta/site/a", alt: "Alt" } } });
  assert.equal(res.status, 200);
  assert.ok((globalThis as any).__revalidated >= 1);
  const map: Record<string, unknown> = {};
  for (const r of db.t("site_content")) map[r.key] = r.value;
  const view = buildFamilyView(map)!;
  assert.equal(view.title, "New heading");
  assert.equal(view.image!.alt, "Alt");
  assert.equal(db.t("site_content").length, 6, "one row per field, no duplicates after a second save");
  assert.equal((await post(familyApi, { content: { ...good, enabled: false } })).status, 200);
  assert.equal(db.t("site_content").length, 6);
  assert.equal(buildFamilyView(Object.fromEntries(db.t("site_content").map((r: any) => [r.key, r.value]))), null);
});

test("the generic content API refuses family_section keys (they have their own validated editor)", async () => {
  const r = await post(contentApi, { key: "family_section.image", value: '{"url":"https://evil.example/x.jpg"}' });
  assert.equal(r.status, 422);
});

test("home page places the section after the trust block, only when enabled, with defaults available offline", () => {
  const page = read("src/app/(site)/page.tsx");
  assert.ok(page.indexOf("<TrustSection") < page.indexOf("<FamilySection"));
  assert.ok(page.includes("{family && <FamilySection view={family} />}"));
  const defaults = read("src/data/defaults.ts");
  for (const k of ["title", "subtitle", "body", "closing", "enabled", "image"]) assert.ok(defaults.includes(`"family_section.${k}"`), k);
});

test("section markup: heading, subheading, paragraph and closing line; accessible image; no third-party watermark text or invented URLs", () => {
  const c = read("src/components/FamilySection.tsx");
  assert.ok(c.includes('aria-labelledby="family-title"') && c.includes("<h2") && c.includes("family__closing") && c.includes("alt={view.image.alt}"));
  assert.ok(c.includes("/brand/vanta-mark.svg"), "branded fallback uses an existing asset");
  const all = c + read("src/lib/family-section.ts") + read("supabase/migrations/0011_hero_slideshow_family_section.sql");
  assert.ok(!/mnmridez/i.test(all) && !/unsplash|pexels|placeholder\.com/i.test(all));
  const css = read("src/app/globals.css");
  assert.ok(css.includes(".family__card") && css.includes("@media (min-width: 861px)"));
});

test("migration seeds the family rows without overwriting existing content and outside the hidden 'Settings' group", () => {
  const m = read("supabase/migrations/0011_hero_slideshow_family_section.sql");
  for (const k of ["enabled", "title", "subtitle", "body", "closing", "image"]) assert.ok(m.includes(`'family_section.${k}'`), k);
  assert.ok(m.includes("on conflict (key) do nothing"));
  assert.ok(m.includes("'Home'"));
});
