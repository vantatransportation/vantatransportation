// Hero background slideshow: view model (order, enabled/disabled, saved timings, fallback), the admin API (add, replace, remove,
// reorder, settings, validation, auth), the public loader, and source-level checks that the hero content/CTAs are intact.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-ignore: plain JS helper
import { FakeDb } from "./integration/fakedb.mjs";
import { DEFAULT_HERO_SETTINGS, buildHeroView, heroImageUrl, heroSrcSet, moveItem, nextIndex, normalizeSettings, overlayGradient, validHeroRef, validateSettingsInput } from "../src/lib/hero.ts";

const db: any = new FakeDb();
const CLOUD = "democloud";
const url = (n: string, folder = "hero") => `https://res.cloudinary.com/${CLOUD}/image/upload/v1/vanta/${folder}/${n}.jpg`;
const pid = (n: string, folder = "hero") => `vanta/${folder}/${n}`;
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const realConsole = { error: console.error, warn: console.warn };
const original = { ...process.env };
let hero: any, heroApi: any, signApi: any, heroData: any, cloudinary: any;
const logs: string[] = [];
let n = 0;
const call = (route: any, body: object) => route.POST(new Request("http://site.test/api/admin/hero", { method: "POST", headers: { "content-type": "application/json", origin: "http://site.test", "x-forwarded-host": "site.test", "x-forwarded-for": `10.8.0.${++n}` }, body: JSON.stringify(body) }));
const api = (body: object) => call(heroApi, body);
const slideRows = () => [...db.t("hero_slides")].sort((a: any, b: any) => a.sort_order - b.sort_order);

before(async () => {
  (globalThis as any).__fakeDb = db;
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "http://fake", SUPABASE_SERVICE_ROLE_KEY: "svc", NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: CLOUD, NEXT_PUBLIC_CLOUDINARY_API_KEY: "123456", CLOUDINARY_API_SECRET: "cloud-secret-xyz" });
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  db.seed("admin_users", [{ user_id: "admin-1", email: "a@x.com" }]);
  hero = await import("../src/lib/hero.ts");
  heroApi = await import("../src/app/api/admin/hero/route.ts");
  signApi = await import("../src/app/api/admin/cloudinary/sign/route.ts");
  heroData = await import("../src/lib/hero-data.ts");
  cloudinary = await import("../src/lib/cloudinary.ts");
});
beforeEach(() => { logs.length = 0; (globalThis as any).__revalidated = 0; (globalThis as any).__cookies = { vt_at: "good" }; });
test.after?.(() => { Object.assign(console, realConsole); process.env = original; });

const row = (id: string, order: number, extra: object = {}) => ({ id, image_url: url(id), image_public_id: pid(id), alt_text: null, sort_order: order, is_active: true, ...extra });

// ---------- view model ----------
test("multiple active images render in the saved order; disabled images are not shown", () => {
  const view = buildHeroView(DEFAULT_HERO_SETTINGS, [row("c", 3), row("a", 1), row("off", 2, { is_active: false }), row("b", 2)])!;
  assert.deepEqual(view.slides.map((s) => s.id), ["a", "b", "c"]);
  assert.ok(!view.slides.some((s) => s.id === "off"));
});

test("the saved fade duration, display time, transition, overlay and autoplay flag are used", () => {
  const settings = normalizeSettings({ autoplay: true, transition: "zoom", fade_ms: 2500, interval_ms: 9000, overlay_opacity: 40, pause_on_hover: false, show_dots: true });
  const view = buildHeroView(settings, [row("a", 1), row("b", 2)])!;
  assert.deepEqual([view.fadeMs, view.intervalMs, view.transition, view.overlayOpacity, view.pauseOnHover, view.showDots, view.autoplay], [2500, 9000, "zoom", 40, false, true, true]);
  assert.equal(buildHeroView({ ...settings, autoplay: false }, [row("a", 1), row("b", 2)])!.autoplay, false);
  assert.equal(buildHeroView(settings, [row("a", 1)])!.autoplay, false, "a single image never starts a timer");
});

test("fallback: no active images (or none at all) gives null, so the original hero is kept", () => {
  assert.equal(buildHeroView(DEFAULT_HERO_SETTINGS, []), null);
  assert.equal(buildHeroView(DEFAULT_HERO_SETTINGS, null), null);
  assert.equal(buildHeroView(DEFAULT_HERO_SETTINGS, [row("a", 1, { is_active: false })]), null);
  assert.equal(buildHeroView(DEFAULT_HERO_SETTINGS, [{ id: "x", image_url: "http://insecure/x.jpg" }]), null, "non-https images are never shown");
});

test("out-of-range stored settings are clamped and unknown values fall back to the defaults", () => {
  const s = normalizeSettings({ transition: "spin", fade_ms: 99999, interval_ms: 1, overlay_opacity: 500 });
  assert.deepEqual([s.transition, s.fadeMs, s.intervalMs, s.overlayOpacity], ["fade", 5000, 2000, 90]);
  assert.deepEqual(normalizeSettings(null), DEFAULT_HERO_SETTINGS);
});

test("responsive Cloudinary delivery: srcset widths, f_auto/q_auto, no change for other hosts", () => {
  const set = heroSrcSet(url("a"))!;
  for (const w of [640, 1280, 1920]) assert.ok(set.includes(`/upload/f_auto,q_auto,c_limit,w_${w}/v1/`) && set.includes(`${w}w`));
  assert.equal(heroImageUrl("https://example.com/x.jpg", 640), "https://example.com/x.jpg");
  assert.equal(heroSrcSet("https://example.com/x.jpg"), undefined);
  const already = "https://res.cloudinary.com/democloud/image/upload/w_100/v1/vanta/hero/a.jpg";
  assert.equal(heroImageUrl(already, 640), already);
});

test("helpers: next index skips failed slides, move keeps the list intact, overlay stays in range", () => {
  assert.equal(nextIndex(0, 3), 1);
  assert.equal(nextIndex(2, 3), 0);
  assert.equal(nextIndex(0, 3, new Set([1])), 2);
  assert.equal(nextIndex(0, 3, new Set([1, 2])), -1);
  assert.equal(nextIndex(0, 1), -1);
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 5, 0), ["a", "b", "c"]);
  assert.ok(overlayGradient(999).includes("rgba(0,0,0,0.9)") && overlayGradient(-5).includes("rgba(0,0,0,0)"));
});

test("settings validation: strict ranges, known transitions, display time not shorter than the fade", () => {
  const ok = { autoplay: true, transition: "fade", fadeMs: 1200, intervalMs: 6000, overlayOpacity: 55, pauseOnHover: true, showDots: false };
  assert.equal(validateSettingsInput(ok).ok, true);
  for (const bad of [{ fadeMs: 100 }, { fadeMs: 6000 }, { intervalMs: 1000 }, { overlayOpacity: 95 }, { transition: "spin" }, { fadeMs: 4000, intervalMs: 3000 }, { fadeMs: 1.5 }]) assert.equal(validateSettingsInput({ ...ok, ...bad }).ok, false, JSON.stringify(bad));
  assert.equal(validateSettingsInput(null).ok, false);
});

test("hero image references must be in our Cloudinary account and the hero folder", () => {
  assert.equal(validHeroRef(url("a"), pid("a"), CLOUD), true);
  assert.equal(validHeroRef(url("a", "vehicles"), pid("a", "vehicles"), CLOUD), false, "vehicle folder is not accepted");
  assert.equal(validHeroRef("https://evil.example/a.jpg", pid("a"), CLOUD), false);
  assert.equal(validHeroRef(`https://res.cloudinary.com/other/image/upload/v1/vanta/hero/a.jpg`, pid("a"), CLOUD), false);
  assert.equal(validHeroRef(url("a"), "vanta/hero/../x", CLOUD), false);
});

// ---------- admin API ----------
test("admin API needs a signed-in admin and a same-origin request", async () => {
  (globalThis as any).__cookies = {};
  assert.equal((await api({ action: "save_settings", settings: {} })).status, 401);
  (globalThis as any).__cookies = { vt_at: "good" };
  const cross = await heroApi.POST(new Request("http://site.test/api/admin/hero", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.test", "x-forwarded-host": "site.test" }, body: "{}" }));
  assert.equal(cross.status, 403);
});

test("the sign route issues hero-folder signatures only on request; the default stays the vehicles folder", async () => {
  const sign = (body: object) => signApi.POST(new Request("http://site.test/api/admin/cloudinary/sign", { method: "POST", headers: { "content-type": "application/json", origin: "http://site.test", "x-forwarded-host": "site.test" }, body: JSON.stringify(body) }));
  const v = await (await sign({ contentType: "image/jpeg", size: 1000 })).json();
  assert.equal(v.folder, "vanta/vehicles");
  const h = await (await sign({ contentType: "image/jpeg", size: 1000, purpose: "hero" })).json();
  assert.equal(h.folder, "vanta/hero");
  assert.notEqual(h.signature, v.signature);
  const x = await (await sign({ contentType: "image/jpeg", size: 1000, purpose: "../../etc" })).json();
  assert.equal(x.folder, "vanta/vehicles", "an unknown purpose falls back to the vehicles folder");
  assert.equal((await sign({ contentType: "application/pdf", size: 1000, purpose: "hero" })).status, 422);
});

test("add, order, disable, replace and remove slides; the public loader follows every change", async () => {
  const realFetch = globalThis.fetch;
  const destroyed: string[] = [];
  globalThis.fetch = (async (u: any, init: any) => { if (String(u).endsWith("/image/destroy")) { destroyed.push(String(init?.body ?? "")); return new Response(JSON.stringify({ result: "ok" })); } throw new Error("unexpected fetch " + u); }) as typeof fetch;
  try {
    // Arbitrary URLs and other folders are refused.
    assert.equal((await api({ action: "add_slide", url: "https://evil.example/a.jpg", publicId: pid("a") })).status, 422);
    assert.equal((await api({ action: "add_slide", url: url("a", "vehicles"), publicId: pid("a", "vehicles") })).status, 422);
    assert.equal(slideRows().length, 0);

    for (const name of ["a", "b", "c"]) assert.equal((await api({ action: "add_slide", url: url(name), publicId: pid(name), alt: `Photo ${name}` })).status, 200);
    assert.ok((globalThis as any).__revalidated >= 3, "the public site is refreshed after every write");
    let view = await heroData.readHero(db);
    assert.deepEqual(view.slides.map((s: any) => s.alt), ["Photo a", "Photo b", "Photo c"]);
    const [a, b, c] = slideRows().map((r: any) => r.id);

    // Reorder: c, a, b. A stale or partial list is rejected.
    assert.equal((await api({ action: "reorder", ids: [c, a] })).status, 409);
    assert.equal((await api({ action: "reorder", ids: [c, a, b] })).status, 200);
    view = await heroData.readHero(db);
    assert.deepEqual(view.slides.map((s: any) => s.alt), ["Photo c", "Photo a", "Photo b"]);

    // Disable b: it disappears; enable again: it returns.
    assert.equal((await api({ action: "update_slide", id: b, isActive: false })).status, 200);
    assert.deepEqual((await heroData.readHero(db)).slides.map((s: any) => s.alt), ["Photo c", "Photo a"]);
    assert.equal((await api({ action: "update_slide", id: b, isActive: true })).status, 200);
    assert.equal((await heroData.readHero(db)).slides.length, 3);

    // Replace a: same position, new image, the old asset is deleted from Cloudinary.
    assert.equal((await api({ action: "replace_slide", id: a, url: url("a2"), publicId: pid("a2") })).status, 200);
    view = await heroData.readHero(db);
    assert.ok(view.slides[1].src.includes("/vanta/hero/a2.jpg"), "replaced image shows in the same position");
    assert.ok(destroyed.some((d) => d.includes(encodeURIComponent(pid("a")))), "old asset released");
    assert.equal(slideRows().length, 3, "replacing never duplicates a slide");

    // Remove b; remaining order is kept.
    assert.equal((await api({ action: "remove_slide", id: b })).status, 200);
    assert.deepEqual((await heroData.readHero(db)).slides.map((s: any) => s.alt), ["Photo c", "Photo a"]);
    assert.ok(destroyed.some((d) => d.includes(encodeURIComponent(pid("b")))));
    assert.equal((await api({ action: "remove_slide", id: b })).status, 404);

    // Disable everything: the loader gives null (fallback hero).
    for (const r of slideRows()) await api({ action: "update_slide", id: r.id, isActive: false });
    assert.equal(await heroData.readHero(db), null);
    assert.ok(db.t("activity_logs").some((l: any) => l.action === "hero.slide_removed"));
  } finally { globalThis.fetch = realFetch; }
});

test("saving settings validates input and the saved timings reach the public view", async () => {
  const good = { autoplay: false, transition: "slide", fadeMs: 800, intervalMs: 4500, overlayOpacity: 30, pauseOnHover: false, showDots: true };
  assert.equal((await api({ action: "save_settings", settings: { ...good, fadeMs: 10 } })).status, 422);
  assert.equal(db.t("hero_settings").length, 0, "nothing is saved when validation fails");
  assert.equal((await api({ action: "save_settings", settings: good })).status, 200);
  assert.equal((await api({ action: "save_settings", settings: { ...good, fadeMs: 1500 } })).status, 200);
  assert.equal(db.t("hero_settings").length, 1, "settings stay a single row");
  const v = await heroData.readHero(db);
  assert.equal(v, null, "no active slides yet");
  db.seed("hero_slides", [row("p", 1), row("q", 2)]);
  const view = await heroData.readHero(db);
  assert.deepEqual([view.fadeMs, view.intervalMs, view.transition, view.overlayOpacity, view.autoplay, view.showDots], [1500, 4500, "slide", 30, false, true]);
});

test("the slideshow is limited to 12 slides", async () => {
  db.t("hero_slides").length = 0;
  for (let i = 0; i < 12; i++) db.seed("hero_slides", [row(`s${i}`, i + 1)]);
  assert.equal((await api({ action: "add_slide", url: url("extra"), publicId: pid("extra") })).status, 422);
  db.t("hero_slides").length = 0;
});

test("the public loader never throws: an unreadable database (migration not applied) means the original hero", async () => {
  const broken: any = { from() { const q: any = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: () => q, then: (r: any, j: any) => Promise.resolve({ data: null, error: { message: 'relation "hero_slides" does not exist' } }).then(r, j) }; return q; } };
  (globalThis as any).__fakeDb = broken;
  try { assert.equal(await heroData.loadHeroView(), null); } finally { (globalThis as any).__fakeDb = db; }
  assert.ok(logs.some((l) => l.includes("[hero]")));
});

test("a hero image still used by a slide or the family section is not deleted from Cloudinary", async () => {
  const realFetch = globalThis.fetch; let destroyed = 0;
  globalThis.fetch = (async () => { destroyed++; return new Response(JSON.stringify({ result: "ok" })); }) as typeof fetch;
  try {
    db.seed("hero_slides", [row("keep", 1)]);
    assert.equal(await cloudinary.releaseAsset(db, pid("keep")), "in_use");
    db.seed("site_content", [{ key: "family_section.image", value: { url: url("fam", "site"), publicId: pid("fam", "site"), alt: "" } }]);
    assert.equal(await cloudinary.releaseAsset(db, pid("fam", "site")), "in_use");
    assert.equal(await cloudinary.releaseAsset(db, pid("free")), "deleted");
    assert.equal(await cloudinary.releaseAsset(db, "other/folder/x"), "skipped");
    assert.equal(destroyed, 1);
  } finally { globalThis.fetch = realFetch; db.t("hero_slides").length = 0; }
});

// ---------- source-level checks ----------
test("home page: hero text, both CTAs, trip form and mark are unchanged; the slideshow is only an extra background layer", () => {
  const page = read("src/app/(site)/page.tsx");
  assert.ok(page.includes('text(content, "hero.title"') && page.includes('text(content, "hero.subtitle")'));
  assert.ok(page.includes('OpenCalculator className="btn btn--primary"') && page.includes('href="/quote" className="btn btn--ghost"'));
  assert.ok(page.includes('<TripStrip cta="See my fare" />') && page.includes("/brand/vanta-mark.svg"));
  assert.ok(page.includes('className={`hero${heroView ? " hero--media" : ""}`}'), "without slides the section keeps the plain 'hero' class");
  assert.ok(page.includes("{heroView && <HeroSlideshow view={heroView} />}"));
});

test("slideshow component: first slide eager and high priority, others preloaded, reduced motion / hidden tab / hover respected", () => {
  const c = read("src/components/HeroSlideshow.tsx");
  assert.ok(c.includes('fetchPriority: "high"') && c.includes("new Image()") && c.includes("img.srcset") && c.includes("img.sizes"));
  assert.ok(c.includes("prefers-reduced-motion: reduce") && c.includes("visibilitychange") && c.includes("mouseenter"));
  assert.ok(c.includes("loaded.filter") , "only loaded slides are rendered");
  const css = read("src/app/globals.css");
  assert.ok(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.hero-ss__layer/.test(css));
  assert.ok(css.includes(".hero--media") && css.includes("position: absolute; inset: 0; z-index: 0"), "background layer cannot shift layout");
});

test("migration 0011 is forward-only and idempotent, with RLS on both tables and no destructive statements", () => {
  const m = read("supabase/migrations/0011_hero_slideshow_family_section.sql");
  assert.ok(!/\b(drop\s+table|truncate|delete\s+from|alter\s+table[^;]*drop\s+column)/i.test(m));
  assert.ok(m.includes("create table if not exists public.hero_settings") && m.includes("create table if not exists public.hero_slides"));
  assert.ok(m.includes("alter table public.hero_settings enable row level security") && m.includes("alter table public.hero_slides enable row level security"));
  assert.ok(m.includes("using (is_active)") && !/for (insert|update|delete) to (anon|authenticated)/i.test(m));
  assert.ok(m.includes("on conflict (id) do nothing") && m.includes("on conflict (key) do nothing"));
  assert.ok(!m.includes("'Settings'") || m.includes("Do NOT use 'Settings'"));
});

test("admin sidebar links the new pages and the pages are admin-gated", () => {
  const side = read("src/components/admin/AdminSidebar.tsx");
  assert.ok(side.includes('"/admin/hero"') && side.includes('"/admin/family"'));
  assert.ok(read("src/app/admin/(panel)/hero/page.tsx").includes("adminPage()"));
  assert.ok(read("src/app/admin/(panel)/family/page.tsx").includes("adminPage()"));
});
