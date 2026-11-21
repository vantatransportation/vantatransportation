// Public fleet photos: home "Our Fleet", category tiles and /rides must show the same saved Cloudinary photo the
// Calculate Your Fare list shows. In-memory database; no network. These tests exercise the data path that feeds the cards
// (getSiteData -> Vehicle.image). The React rendering of VehiclePhoto is covered by the production-build smoke check.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore: plain JS helper
import { FakeDb } from "./integration/fakedb.mjs";
import { resolvePhotoSrc, photoUrl, hasRealPhoto } from "../src/lib/vehicle-photo.ts";
import { pickCategoryVehicle } from "../src/lib/fleet-data.ts";

const svc: any = new FakeDb();
const CLOUD = "democloud";
const url = (n: string) => `https://res.cloudinary.com/${CLOUD}/image/upload/v1/vanta/vehicles/${n}.jpg`;

/** A client that is not allowed to read anything: models a missing/invalid anon key or an RLS / embed failure. */
const brokenClient: any = {
  from() {
    const q: any = { select: () => q, eq: () => q, order: () => q, limit: () => q, then: (res: any, rej: any) => Promise.resolve({ data: null, error: { message: "permission denied" } }).then(res, rej) };
    return q;
  },
};

const logs: { level: string; msg: string }[] = [];
const realConsole = { error: console.error, warn: console.warn, info: console.info };
const original = { ...process.env };
let content: any, fareService: any, routes: any;
const ids: Record<string, string> = {};

const useClients = (opts: { anon: any | null; service: any | null }) => {
  (globalThis as any).__fakeDbByKey = { ...(opts.anon ? { anon: opts.anon } : {}), ...(opts.service ? { svckey: opts.service } : {}) };
  if (opts.anon) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon"; else delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (opts.service) process.env.SUPABASE_SERVICE_ROLE_KEY = "svckey"; else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
};

before(async () => {
  (globalThis as any).__fakeDb = svc;
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "http://fake", NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: CLOUD, NEXT_PUBLIC_CLOUDINARY_API_KEY: "123456", CLOUDINARY_API_SECRET: "cloud-secret-xyz",
    NEXT_PUBLIC_SITE_URL: "http://site.test",
  });
  for (const level of ["error", "warn", "info"] as const) (console as any)[level] = (...a: unknown[]) => logs.push({ level, msg: a.map(String).join(" ") });
  svc.seed("vehicle_categories", [
    { name: "Vans", slug: "vans", description: "Vans", capacity_label: "11–14 passengers", image_url: "/vehicles/van.svg", is_active: true, sort_order: 1 },
    { name: "Large SUVs", slug: "large-suvs", description: "SUVs", capacity_label: "6–7 passengers", image_url: "/vehicles/suv.svg", is_active: true, sort_order: 2 },
    { name: "Sedans", slug: "sedans", description: "Sedans", capacity_label: "2–3 passengers", image_url: "/vehicles/sedan.svg", is_active: true, sort_order: 3 },
    { name: "Retired", slug: "retired", description: "Hidden", capacity_label: "", image_url: null, is_active: false, sort_order: 4 },
  ]);
  svc.seed("vehicle_tiers", [{ name: "Premium", slug: "premium", sort_order: 1, is_active: true }, { name: "Luxury", slug: "luxury", sort_order: 2, is_active: false }]);
  const cat = (slug: string) => svc.t("vehicle_categories").find((c: any) => c.slug === slug).id;
  const [premium, luxuryInactive] = svc.t("vehicle_tiers").map((t: any) => t.id);
  const base = { is_active: true, is_available: true, passenger_capacity: 4 };
  svc.seed("vehicles", [
    { ...base, name: "Sprinter", category_id: cat("vans"), tier_id: premium, sort_order: 1, image_url: url("sprinter"), image_public_id: "vanta/vehicles/sprinter" },
    { ...base, name: "Transit", category_id: cat("vans"), tier_id: premium, sort_order: 2, image_url: null },
    { ...base, name: "Suburban", category_id: cat("large-suvs"), tier_id: premium, sort_order: 3, is_available: false, image_url: url("suburban"), image_public_id: "vanta/vehicles/suburban" },
    { ...base, name: "Escalade", category_id: cat("large-suvs"), tier_id: luxuryInactive, sort_order: 4, image_url: url("escalade"), image_public_id: "vanta/vehicles/escalade" },
    { ...base, name: "S-Class", category_id: cat("sedans"), tier_id: premium, sort_order: 5, image_url: "/vehicles/sedan.svg" },
    { ...base, name: "Hidden Van", category_id: cat("vans"), tier_id: premium, sort_order: 6, is_active: false, image_url: url("hidden") },
    { ...base, name: "Retired Car", category_id: cat("retired"), tier_id: premium, sort_order: 7, image_url: url("retired") },
  ]);
  for (const v of svc.t("vehicles")) ids[v.name] = v.id;
  svc.seed("admin_users", [{ user_id: "admin-1", email: "a@x.com" }]);
  content = await import("../src/lib/content.ts");
  fareService = await import("../src/lib/fare/service.ts");
  routes = { crud: await import("../src/app/api/admin/crud/route.ts") };
});
beforeEach(() => { logs.length = 0; (globalThis as any).__revalidated = 0; });
test.after?.(() => { Object.assign(console, realConsole); process.env = original; });

const names = (list: { name: string }[]) => list.map((v) => v.name);
const byName = (list: any[], n: string) => list.find((v) => v.name === n);

test("ROOT CAUSE: the fleet cards get the saved photo even when the anonymous client cannot read the database", async () => {
  // Before the fix this exact situation (anon read fails, service-role works as in the calculator) returned the built-in
  // defaults, whose vehicles have image: null, so every card showed "Photo coming soon".
  useClients({ anon: brokenClient, service: svc });
  const site = await content.getSiteData();
  assert.equal(byName(site.vehicles, "Sprinter").image, url("sprinter"));
  assert.ok(site.vehicles.length > 0 && site.vehicles.every((v: any) => v.id !== "sprinter" && v.id !== "transit"), "must not be the built-in default vehicles");
  assert.ok(logs.some((l) => l.level === "info" && l.msg.includes("fleet loaded via service client")));
});

test("ROOT CAUSE: a missing anon key no longer wipes vehicle photos (and is logged)", async () => {
  useClients({ anon: null, service: svc });
  const site = await content.getSiteData();
  assert.equal(byName(site.vehicles, "Sprinter").image, url("sprinter"));
  assert.ok(logs.some((l) => l.level === "error" && /ANON_KEY missing/.test(l.msg)));
});

test("falls back to the anonymous client when no service-role key is configured", async () => {
  useClients({ anon: svc, service: null });
  const site = await content.getSiteData();
  assert.equal(byName(site.vehicles, "Sprinter").image, url("sprinter"));
  assert.ok(logs.some((l) => l.msg.includes("fleet loaded via public client")));
});

test("when no client can read, the built-in defaults are shown and the reason is logged", async () => {
  useClients({ anon: brokenClient, service: brokenClient });
  const site = await content.getSiteData();
  assert.equal(site.source, "defaults");
  assert.ok(site.vehicles.every((v: any) => v.image === null));
  assert.ok(logs.some((l) => l.level === "error" && l.msg.includes("fleet could not be read")));
});

test("valid Cloudinary photo reaches the fleet cards, the same URL the calculator gets", async () => {
  useClients({ anon: svc, service: svc });
  const site = await content.getSiteData();
  const fleet = await fareService.loadFleet(svc); // Calculate Your Fare's loader (bookable vehicles only)
  for (const f of fleet) assert.equal(byName(site.vehicles, f.name).image, f.image, `${f.name}: card and calculator must agree`);
  assert.equal(byName(fleet, "Sprinter").image, url("sprinter"));
  // Both sides feed the same VehiclePhoto component, which applies the same photoUrl() transformation.
  assert.equal(photoUrl(byName(site.vehicles, "Sprinter").image, 640, 400), photoUrl(byName(fleet, "Sprinter").image, 640, 400));
});

test("no real photo keeps the existing fallback; SVG illustrations are never treated as photos", async () => {
  useClients({ anon: svc, service: svc });
  const site = await content.getSiteData();
  assert.equal(byName(site.vehicles, "Transit").image, null); // no photo at all -> "Photo coming soon"
  assert.equal(byName(site.vehicles, "S-Class").image, null); // legacy /vehicles/sedan.svg value -> placeholder, not a wrong-vehicle drawing
  assert.equal(hasRealPhoto(byName(site.vehicles, "Transit").image), false);
  // Category tiles keep their SVG illustration.
  const vans = site.categories.find((c: any) => c.slug === "vans");
  assert.equal(vans.image, "/vehicles/van.svg");
  assert.equal(pickCategoryVehicle(site.vehicles, "sedans"), null);
  assert.equal(site.categories.find((c: any) => c.slug === "sedans").image, "/vehicles/sedan.svg");
});

test("photo URL handling is consistent", () => {
  assert.equal(resolvePhotoSrc(url("a")), url("a"));
  assert.equal(resolvePhotoSrc(`  ${url("a")}  `), url("a"));
  assert.equal(resolvePhotoSrc("http://res.cloudinary.com/democloud/image/upload/v1/a.jpg"), "https://res.cloudinary.com/democloud/image/upload/v1/a.jpg");
  assert.equal(resolvePhotoSrc("http://example.com/a.jpg"), null);
  assert.equal(resolvePhotoSrc("//res.cloudinary.com/democloud/image/upload/a.jpg"), "https://res.cloudinary.com/democloud/image/upload/a.jpg");
  for (const bad of ["/vehicles/sedan.svg", "/vehicles/van.svg", "", "   ", null, undefined, 42, "/../etc/passwd.jpg", "vehicles/x.jpg"]) assert.equal(resolvePhotoSrc(bad), null, String(bad));
  assert.equal(resolvePhotoSrc("/vehicles/photo.jpg"), "/vehicles/photo.jpg"); // legacy local raster photo
  const t = photoUrl(url("a"), 640, 400);
  assert.ok(t.includes("/upload/f_auto,q_auto,c_fill,g_auto,w_640,h_400/v1/"));
  assert.equal(photoUrl(t, 640, 400), t); // never transformed twice
  assert.equal(photoUrl("https://example.com/a.jpg", 640, 400), "https://example.com/a.jpg"); // other hosts untouched
});

test("visibility rules: Shown on website hides; Available to book only affects the calculator", async () => {
  useClients({ anon: svc, service: svc });
  const site = await content.getSiteData();
  assert.ok(!names(site.vehicles).includes("Hidden Van"), "is_active=false must not appear on the public cards");
  assert.ok(!site.categories.some((c: any) => c.slug === "retired"));
  const suburban = byName(site.vehicles, "Suburban");
  assert.ok(suburban && suburban.isAvailable === false, "unavailable vehicles stay listed with the 'Currently unavailable' badge");
  // An inactive tier is treated as absent (what RLS does for the anonymous client), the vehicle itself stays.
  assert.equal(byName(site.vehicles, "Escalade").tierName, "");
  // A vehicle in an inactive category is listed on the home fleet but cannot match a category section on /rides.
  assert.equal(byName(site.vehicles, "Retired Car").categorySlug, "");
  // Calculator: needs is_active AND is_available (unchanged).
  const fleet = await fareService.loadFleet(svc);
  assert.ok(!names(fleet).includes("Suburban") && !names(fleet).includes("Hidden Van"));
  assert.ok(names(fleet).includes("Sprinter"));
});

test("category tiles prefer a bookable vehicle's photo, then any photo, otherwise keep the illustration", async () => {
  useClients({ anon: svc, service: svc });
  const site = await content.getSiteData();
  // Vans: Sprinter has the photo. SUVs: only the unavailable Suburban and the inactive-tier Escalade have photos -> bookable one wins.
  assert.equal(pickCategoryVehicle(site.vehicles, "vans")?.name, "Sprinter");
  const suvs = pickCategoryVehicle(site.vehicles, "large-suvs");
  assert.equal(suvs?.name, "Escalade"); // available, has a photo
  const only = [{ ...byName(site.vehicles, "Suburban") }];
  assert.equal(pickCategoryVehicle(only, "large-suvs")?.name, "Suburban"); // unavailable but the only photo: still better than a drawing
  assert.equal(pickCategoryVehicle(site.vehicles, "unknown-slug"), null);
});

test("saving a photo in admin persists the Cloudinary URL and the public cards show it immediately; removal restores the fallback", async () => {
  useClients({ anon: svc, service: svc });
  (globalThis as any).__cookies = { vt_at: "good" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: any) => { if (String(u).endsWith("/image/destroy")) return new Response(JSON.stringify({ result: "ok" })); throw new Error("unexpected fetch " + u); }) as typeof fetch;
  let n = 0;
  const save = (id: string, values: object) => routes.crud.POST(new Request("http://site.test/api/admin/crud", { method: "POST", headers: { "content-type": "application/json", origin: "http://site.test", "x-forwarded-host": "site.test", "x-forwarded-for": `10.9.0.${++n}` }, body: JSON.stringify({ resource: "vehicles", action: "update", id, values }) }));
  try {
    assert.equal(byName((await content.getSiteData()).vehicles, "Transit").image, null);
    const res = await save(ids["Transit"], { image_url: url("transit"), image_public_id: "vanta/vehicles/transit" });
    assert.equal(res.status, 200);
    const row = svc.t("vehicles").find((v: any) => v.id === ids["Transit"]);
    assert.equal(row.image_url, url("transit")); // persisted to vehicles.image_url
    assert.equal(row.image_public_id, "vanta/vehicles/transit"); // and vehicles.image_public_id
    assert.ok((globalThis as any).__revalidated >= 1, "the public pages must be revalidated after the save");
    assert.equal(byName((await content.getSiteData()).vehicles, "Transit").image, url("transit")); // fleet cards
    assert.equal(byName(await fareService.loadFleet(svc), "Transit").image, url("transit")); // calculator
    // Replace, then remove.
    assert.equal((await save(ids["Transit"], { image_url: url("transit2"), image_public_id: "vanta/vehicles/transit2" })).status, 200);
    assert.equal(byName((await content.getSiteData()).vehicles, "Transit").image, url("transit2"));
    assert.equal((await save(ids["Transit"], { image_url: "", image_public_id: "" })).status, 200);
    assert.equal(byName((await content.getSiteData()).vehicles, "Transit").image, null);
  } finally { globalThis.fetch = realFetch; (globalThis as any).__cookies = {}; }
});
