import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import manifest from "../src/app/manifest.ts";

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const pngSize = (p: string) => { const b = readFileSync(new URL(p, root)); assert.equal(b.subarray(1, 4).toString(), "PNG"); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test("manifest: installable identity, same-origin scope, branded colours", () => {
  const m = manifest();
  assert.equal(m.name, "Vanta Transportation");
  assert.equal(m.short_name, "Vanta");
  assert.equal(m.start_url, "/");
  assert.equal(m.scope, "/");
  assert.equal(m.display, "standalone");
  assert.equal(m.theme_color, "#000000");
  assert.equal(m.background_color, "#000000");
});

test("manifest: every icon exists on disk at its declared size, incl. 192/512 and maskable", () => {
  const m = manifest();
  const icons = m.icons ?? [];
  for (const i of icons) {
    assert.ok(i.src.startsWith("/icons/") && existsSync(new URL(`public${i.src}`, root)), `${i.src} missing`);
    const [w, h] = pngSize(`public${i.src}`);
    assert.equal(`${w}x${h}`, i.sizes);
  }
  for (const purpose of ["any", "maskable"]) for (const size of ["192x192", "512x512"]) assert.ok(icons.some((i) => i.purpose === purpose && i.sizes === size), `${purpose} ${size}`);
  assert.deepEqual(pngSize("public/icons/apple-touch-icon.png"), [180, 180]);
});

test("manifest shortcuts point at real routes only, and never at the admin panel", () => {
  for (const s of manifest().shortcuts ?? []) {
    const page = s.url.replace(/^\//, "");
    assert.ok(existsSync(new URL(`src/app/(site)/${page}/page.tsx`, root)) || existsSync(new URL(`src/app/${page}/page.tsx`, root)), `${s.url} is not a real route`);
    assert.ok(!s.url.startsWith("/admin"));
  }
});

// ---- service worker: run the real file against mocked browser APIs ----
function loadSw() {
  const listeners: Record<string, (e: any) => void> = {};
  const store = new Map<string, Response | string>();
  const puts: string[] = [];
  const fetched: string[] = [];
  let online = true;
  const cache = {
    addAll: async (urls: string[]) => { for (const u of urls) store.set(u, "precached"); },
    put: async (req: any) => { puts.push(typeof req === "string" ? req : req.url); store.set(typeof req === "string" ? req : req.url, "cached"); },
  };
  const ctx: any = {
    self: { location: { origin: "https://vantatransportation.com" }, addEventListener: (t: string, f: any) => { listeners[t] = f; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: {
      open: async () => cache, keys: async () => [], delete: async () => true,
      match: async (r: any) => { const k = typeof r === "string" ? r : r.url; const path = k.replace("https://vantatransportation.com", ""); return store.has(path) || store.has(k) ? { cached: true, url: k } : undefined; },
    },
    fetch: async (r: any) => { fetched.push(r.url); if (!online) throw new Error("offline"); return { ok: true, type: "basic", clone() { return this; }, url: r.url }; },
    Response: { error: () => ({ error: true }) }, URL, Promise, console,
  };
  vm.runInNewContext(read("public/sw.js"), ctx);
  const fire = (url: string, init: { method?: string; mode?: string } = {}) => {
    let responded: Promise<any> | undefined;
    listeners.fetch({ request: { url, method: init.method ?? "GET", mode: init.mode ?? "cors" }, respondWith: (p: Promise<any>) => { responded = p; } });
    return responded;
  };
  return { fire, puts, fetched, store, setOnline: (v: boolean) => { online = v; }, listeners };
}
const O = "https://vantatransportation.com";

test("service worker: never intercepts writes, API, Supabase/other origins or private pages' data", async () => {
  const sw = loadSw();
  for (const m of ["POST", "PATCH", "PUT", "DELETE"]) assert.equal(sw.fire(`${O}/api/bookings`, { method: m }), undefined);
  for (const p of ["/api/bookings", "/api/driver/messages", "/api/admin/crud", "/api/payments/checkout", "/api/track", "/driver?_rsc=1", "/admin/bookings?_rsc=1", "/trip/abc", "/pay/abc"]) assert.equal(sw.fire(`${O}${p}`), undefined, p);
  assert.equal(sw.fire("https://abc.supabase.co/auth/v1/token?grant_type=refresh_token"), undefined);
  assert.equal(sw.fire("https://res.cloudinary.com/x/image/upload/a.jpg"), undefined);
  assert.deepEqual(sw.puts, []);
});

test("service worker: page navigations are network-first with no caching; offline shows the offline page only", async () => {
  const sw = loadSw();
  await sw.listeners.install({ waitUntil: (p: Promise<unknown>) => p });
  for (const p of ["/admin", "/driver", "/driver/set-password", "/book", "/track"]) {
    const r = await sw.fire(`${O}${p}`, { mode: "navigate" });
    assert.equal(r.url, `${O}${p}`); // came from the network
  }
  assert.deepEqual(sw.puts, []); // navigations are never stored
  sw.setOnline(false);
  const off = await sw.fire(`${O}/admin/payments`, { mode: "navigate" });
  assert.equal(off.cached, true);
  assert.ok(off.url.endsWith("/offline.html"));
});

test("service worker: only public static assets are cached", async () => {
  const sw = loadSw();
  await sw.fire(`${O}/_next/static/chunks/app-123.js`);
  await sw.fire(`${O}/icons/icon-192.png`);
  assert.deepEqual(sw.puts.map((u) => new URL(u).pathname).sort(), ["/_next/static/chunks/app-123.js", "/icons/icon-192.png"]);
  assert.equal(sw.fire(`${O}/_next/data/x/book.json`), undefined);
  assert.equal(sw.fire(`${O}/vehicles/sedan.svg`), undefined);
});

test("service worker source: precache list is static-only and has no request-body or credential handling", () => {
  const src = read("public/sw.js");
  const pre = /const PRECACHE = \[([^\]]*)\]/.exec(src)![1];
  assert.ok(!/api|admin|driver|trip|pay|track/.test(pre));
  assert.ok(!/localStorage|Authorization|cookie|\.body|postMessage/i.test(src.replace(/\/\*[\s\S]*?\*\//g, "")));
});

test("offline page and wiring: explains live features need a connection; sw is registered, headers set", () => {
  const html = read("public/offline.html");
  assert.match(html, /booking, payment, live ride tracking and driver chat/i);
  assert.match(read("src/app/layout.tsx"), /<PwaRegister \/>/);
  assert.match(read("src/components/SiteFooter.tsx"), /<InstallApp \/>/);
  assert.match(read("next.config.ts"), /source: "\/sw\.js"[\s\S]*no-cache/);
  assert.match(read("src/components/PwaRegister.tsx"), /NODE_ENV !== "production"/);
});
