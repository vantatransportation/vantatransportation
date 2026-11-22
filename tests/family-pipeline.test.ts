// Family section: admin -> Supabase -> public rendering pipeline. Regression tests for "saved image/text does not show on the
// site (V mark and default copy still displayed)". In-memory databases only (no network, no live Supabase): the anonymous
// client is modelled separately from the service-role client so RLS-style differences can be reproduced.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-ignore: plain JS helper
import { FakeDb } from "./integration/fakedb.mjs";
import { FAMILY_DEFAULTS, buildFamilyInput, buildFamilyView } from "../src/lib/family-section.ts";

const CLOUD = "democloud";
const imgUrl = (n: string) => `https://res.cloudinary.com/${CLOUD}/image/upload/v1700000000/vanta/site/${n}.jpg`;
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

let svc: any;
/** The anonymous (publishable-key) client: same data, but rows in the "Settings" group are invisible (RLS "public read site content"). */
const anonView: any = {
  from(name: string) {
    const tmp: any = new FakeDb();
    tmp.tables = { ...svc.tables, site_content: svc.t("site_content").filter((r: any) => r.group_name !== "Settings") };
    return tmp.from(name);
  },
};
/** A client that cannot read anything (missing/invalid key, a failing unrelated table, ...). */
const brokenClient: any = {
  from() {
    const q: any = { select: () => q, in: () => q, eq: () => q, order: () => q, limit: () => q, then: (res: any, rej: any) => Promise.resolve({ data: null, error: { message: "permission denied" } }).then(res, rej) };
    return q;
  },
};
const useClients = (anon: any | null, service: any | null) => {
  (globalThis as any).__fakeDbByKey = { ...(anon ? { anon } : {}), ...(service ? { svckey: service } : {}) };
  if (anon) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon"; else delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (service) process.env.SUPABASE_SERVICE_ROLE_KEY = "svckey"; else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
};

const logs: { level: string; msg: string }[] = [];
const realConsole = { error: console.error, warn: console.warn, info: console.info };
const original = { ...process.env };
let familyApi: any, familyData: any, content: any;
let n = 0;
const post = (content: object) => familyApi.POST(new Request("http://site.test/api/admin/family", { method: "POST", headers: { "content-type": "application/json", origin: "http://site.test", "x-forwarded-host": "site.test", "x-forwarded-for": `10.9.0.${++n}` }, body: JSON.stringify({ content }) }));
const form = (over: Record<string, unknown> = {}) => ({ enabled: true, title: "Every Passenger Is Family.", subtitle: "Sub", body: "Body", closing: "Closing", image: { url: "", publicId: "", alt: "" }, ...over });
const withImage = (name: string, alt = "Alt text") => ({ image: { url: imgUrl(name), publicId: `vanta/site/${name}`, alt } });
const stored = () => Object.fromEntries(svc.t("site_content").map((r: any) => [r.key, r.value]));

before(async () => {
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "http://fake", NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: CLOUD, NEXT_PUBLIC_CLOUDINARY_API_KEY: "1", CLOUDINARY_API_SECRET: "s" });
  for (const level of ["error", "warn", "info"] as const) (console as any)[level] = (...a: unknown[]) => logs.push({ level, msg: a.map(String).join(" ") });
  familyApi = await import("../src/app/api/admin/family/route.ts");
  familyData = await import("../src/lib/family-data.ts");
  content = await import("../src/lib/content.ts");
});
beforeEach(() => {
  svc = new FakeDb();
  (globalThis as any).__fakeDb = svc;
  svc.seed("admin_users", [{ user_id: "admin-1", email: "a@x.com" }]);
  (globalThis as any).__cookies = { vt_at: "good" };
  (globalThis as any).__revalidated = 0;
  useClients(anonView, svc);
  logs.length = 0;
});
test.after?.(() => { Object.assign(console, realConsole); process.env = original; });

test("ROOT CAUSE 1: a saved Family edit still renders when the anonymous all-content read fails (it used to fall back to the defaults + Vanta mark)", async () => {
  assert.equal((await post(form({ title: "TEST HEADING 123", body: "TEST DESCRIPTION 456", ...withImage("fam1") }))).status, 200);
  useClients(brokenClient, svc); // the anon batch (FAQs, standards, site content) fails, as in the fleet-photo incident

  // The old path (getSiteData().content -> buildFamilyView) silently produced the built-in copy and no image:
  const legacy = buildFamilyView((await content.getSiteData()).content)!;
  assert.equal(legacy.title, FAMILY_DEFAULTS.title);
  assert.equal(legacy.image, null);

  // The public page now reads the Family rows through its own loader:
  const view = buildFamilyView(await familyData.loadFamilyContent())!;
  assert.equal(view.title, "TEST HEADING 123");
  assert.equal(view.body, "TEST DESCRIPTION 456");
  assert.ok(view.image && view.image.src.includes("/vanta/site/fam1.jpg"));
  assert.ok(logs.some((l) => l.level === "info" && l.msg.includes("family section loaded via service client")));
});

test("ROOT CAUSE 1b: a missing anon key no longer hides the saved section; with no service key the anon client is used", async () => {
  await post(form({ title: "Saved title", ...withImage("fam2") }));
  useClients(null, svc);
  assert.equal(buildFamilyView(await familyData.loadFamilyContent())!.title, "Saved title");
  useClients(anonView, null);
  const v = buildFamilyView(await familyData.loadFamilyContent())!;
  assert.equal(v.title, "Saved title");
  assert.ok(v.image!.src.includes("/vanta/site/fam2.jpg"));
  assert.ok(logs.some((l) => l.msg.includes("loaded via public client")));
});

test("when no client can read, the built-in copy and the Vanta mark remain and the reason is logged (existing fallback preserved)", async () => {
  useClients(brokenClient, brokenClient);
  const v = buildFamilyView(await familyData.loadFamilyContent())!;
  assert.equal(v.title, FAMILY_DEFAULTS.title);
  assert.equal(v.image, null);
  assert.ok(logs.some((l) => l.level === "error" && l.msg.includes("could not be read with any Supabase client")));
});

test("ROOT CAUSE 2: rows stored in the hidden \"Settings\" group (invisible to the anon key) render, are reported, and one admin save moves them to \"Home\"", async () => {
  const hidden = (key: string, value: unknown) => ({ key, label: key, group_name: "Settings", value, is_placeholder: false });
  svc.seed("site_content", [hidden("family_section.title", "Saved earlier"), hidden("family_section.image", { url: imgUrl("old"), publicId: "vanta/site/old", alt: "" })]);
  const before = buildFamilyView(Object.fromEntries((await anonView.from("site_content").select("key,value").in("key", familyData.FAMILY_ROW_KEYS)).data.map((r: any) => [r.key, r.value])))!;
  assert.equal(before.title, FAMILY_DEFAULTS.title, "an anon-only read cannot see these rows (the bug)");
  assert.equal(before.image, null);

  const v = buildFamilyView(await familyData.loadFamilyContent())!;
  assert.equal(v.title, "Saved earlier");
  assert.ok(v.image!.src.includes("/vanta/site/old.jpg"));
  assert.ok(logs.some((l) => l.level === "warn" && l.msg.includes("hidden from public reads")));

  assert.equal((await post(form({ title: "Fixed by save", ...withImage("new") }))).status, 200);
  assert.ok(svc.t("site_content").every((r: any) => r.group_name === "Home"), "every Family row is public after a save");
  assert.equal(svc.t("site_content").length, 6, "no duplicate rows");
  useClients(anonView, null); // anonymous reads alone now show the saved values
  const after = buildFamilyView(await familyData.loadFamilyContent())!;
  assert.equal(after.title, "Fixed by save");
  assert.ok(after.image!.src.includes("/vanta/site/new.jpg"));
});

test("IMAGE round trip: exact Cloudinary URL saved, still selected after an admin reload, shown publicly, persists on refresh, replaceable and removable", async () => {
  const res = await post(form(withImage("a", "Family at the car")));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.revalidated, true);
  assert.ok((globalThis as any).__revalidated >= 1, "the public pages are revalidated on save");
  assert.deepEqual(stored()["family_section.image"], { url: imgUrl("a"), publicId: "vanta/site/a", alt: "Family at the car" }, "exact URL stored in the intended row");

  // admin reload: the editor is pre-filled from the same rows
  const admin = buildFamilyInput((await familyData.readFamilyRows(svc)).content);
  assert.deepEqual(admin.image, { url: imgUrl("a"), publicId: "vanta/site/a", alt: "Family at the car" });
  assert.deepEqual(body.content.image, admin.image, "the save response carries what the database holds");

  // public render, twice (refresh)
  for (let i = 0; i < 2; i++) {
    const view = buildFamilyView(await familyData.loadFamilyContent())!;
    assert.ok(view.image!.src.startsWith(`https://res.cloudinary.com/${CLOUD}/image/upload/`) && view.image!.src.endsWith("/v1700000000/vanta/site/a.jpg"));
    assert.equal(view.image!.alt, "Family at the car");
  }

  // replace, then remove: the Vanta mark only comes back when no image is configured
  await post(form(withImage("b")));
  assert.ok(buildFamilyView(await familyData.loadFamilyContent())!.image!.src.includes("/vanta/site/b.jpg"));
  await post(form({ image: { url: "", publicId: "", alt: "" } }));
  assert.equal(buildFamilyView(await familyData.loadFamilyContent())!.image, null);
});

test("TEXT round trip: heading, description, closing and subheading save, persist across an admin reload and show publicly; the switch hides the section", async () => {
  const res = await post(form({ title: "TEST HEADING 789", subtitle: "TEST SUB", body: "TEST DESCRIPTION 789", closing: "TEST CLOSING" }));
  assert.equal(res.status, 200);
  const admin = buildFamilyInput((await familyData.readFamilyRows(svc)).content);
  assert.deepEqual([admin.title, admin.subtitle, admin.body, admin.closing], ["TEST HEADING 789", "TEST SUB", "TEST DESCRIPTION 789", "TEST CLOSING"]);
  const view = buildFamilyView(await familyData.loadFamilyContent())!;
  assert.deepEqual([view.title, view.subtitle, view.body, view.closing], ["TEST HEADING 789", "TEST SUB", "TEST DESCRIPTION 789", "TEST CLOSING"]);
  await post(form({ title: "TEST HEADING 790" })); // a second save updates in place
  assert.equal(buildFamilyView(await familyData.loadFamilyContent())!.title, "TEST HEADING 790");
  assert.equal(svc.t("site_content").length, 6);
  await post(form({ enabled: false }));
  assert.equal(buildFamilyView(await familyData.loadFamilyContent()), null);
});

test("with nothing configured the section keeps its built-in copy and the Vanta mark; only a configured image replaces the mark", async () => {
  const v = buildFamilyView(await familyData.loadFamilyContent())!;
  assert.equal(v.title, FAMILY_DEFAULTS.title);
  assert.equal(v.image, null);
  const c = read("src/components/FamilySection.tsx");
  assert.ok(c.includes("{view.image ? (") && c.includes("/brand/vanta-mark.svg"), "the mark is the fallback only");
});

test("a failed write is reported, changes nothing (all six rows are one statement) and does not refresh the site", async () => {
  await post(form({ title: "Original" }));
  (globalThis as any).__revalidated = 0;
  svc.failWritesFor.add("site_content");
  const res = await post(form({ title: "Should not save", ...withImage("x") }));
  assert.equal(res.status, 500);
  assert.equal(stored()["family_section.title"], "Original");
  assert.equal((globalThis as any).__revalidated, 0);
  assert.ok(logs.some((l) => l.level === "error" && l.msg.includes("[admin/family] save failed")));
});

test("success is never reported when the database does not return the stored rows (no false success)", async () => {
  const lying: any = { auth: svc.auth, from: (name: string) => (name === "site_content" ? { select: (...a: any[]) => svc.from(name).select(...a), upsert: () => ({ select: async () => ({ data: [], error: null }) }) } : svc.from(name)) };
  useClients(anonView, lying);
  (globalThis as any).__revalidated = 0;
  const res = await post(form({ title: "Not stored" }));
  assert.equal(res.status, 500);
  assert.equal((globalThis as any).__revalidated, 0);
  assert.ok(logs.some((l) => l.msg.includes("did not return the saved values")));
});

test("values stored as JSON strings (image object, switch) are read as what they mean instead of being ignored", () => {
  const raw = JSON.stringify({ url: imgUrl("s"), publicId: "vanta/site/s", alt: "x" });
  assert.ok(buildFamilyView({ "family_section.image": raw })!.image!.src.includes("/vanta/site/s.jpg"));
  assert.equal(buildFamilyInput({ "family_section.image": raw }).image.publicId, "vanta/site/s");
  assert.equal(buildFamilyView({ "family_section.enabled": "false" }), null);
  assert.equal(buildFamilyInput({ "family_section.enabled": "false" }).enabled, false);
  assert.equal(buildFamilyView({ "family_section.image": "not json {" })!.image, null);
});

test("wiring: the public page reads Family content with its own loader; the admin page reads the same six rows with the same reader", () => {
  const page = read("src/app/(site)/page.tsx");
  assert.ok(page.includes("buildFamilyView(await loadFamilyContent())"));
  assert.ok(!page.includes("buildFamilyView(content)"));
  assert.ok(page.includes("export const revalidate = 60"));
  const admin = read("src/app/admin/(panel)/family/page.tsx");
  assert.ok(admin.includes("readFamilyRows(db)") && !admin.includes(".like("));
  const api = read("src/app/api/admin/family/route.ts");
  assert.ok(api.includes("upsert(rows") && api.includes('group_name: "Home"') && api.includes("revalidateSite()"));
});
