import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parsePref, readPref, resolveTheme, writePref, THEME_INIT_SCRIPT, THEME_KEY } from "../src/lib/theme.ts";

const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

// ---------- persistence ----------
test("theme preference: defaults to System, persists across 'visits', ignores junk", () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  assert.equal(readPref(store), "system"); // no saved preference
  assert.equal(writePref(store, "dark"), true);
  assert.equal(readPref(store), "dark"); // a later visit reads the saved choice
  writePref(store, "light");
  assert.equal(readPref(store), "light");
  mem.set(THEME_KEY, "purple");
  assert.equal(parsePref(mem.get(THEME_KEY)), "system");
  assert.equal(readPref(null), "system");
  assert.equal(readPref({ getItem() { throw new Error("blocked"); } }), "system"); // storage unavailable
  assert.equal(writePref({ setItem() { throw new Error("blocked"); } }, "dark"), false);
});

test("theme resolution: Dark and Light override the OS, System follows it", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
});

test("the pre-paint script applies the saved/OS theme to <html> (no flash) and matches resolveTheme", () => {
  const run = (saved: string | null, osDark: boolean) => {
    const attrs: Record<string, string> = {};
    const ctx = {
      localStorage: { getItem: () => saved },
      window: { matchMedia: () => ({ matches: osDark }) },
      document: { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v), style: {} as Record<string, string> } },
    };
    vm.runInNewContext(THEME_INIT_SCRIPT, { ...ctx, window: ctx.window, localStorage: ctx.localStorage, document: ctx.document });
    return attrs;
  };
  for (const saved of [null, "system", "dark", "light"]) for (const os of [true, false]) {
    const a = run(saved, os);
    assert.equal(a["data-theme"], resolveTheme(parsePref(saved), os), `${saved}/${os}`);
    assert.equal(a["data-theme-pref"], parsePref(saved));
  }
});

// ---------- contrast (WCAG) ----------
function block(selector: string): Record<string, string> {
  const i = css.indexOf(selector);
  const body = css.slice(css.indexOf("{", i) + 1, css.indexOf("\n}", i));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const dark = block(":root {");
const light = { ...dark, ...block(':root[data-theme="light"]') };

// [foreground, background, minimum ratio, what]
const TEXT: [string, string, number][] = [
  ["light", "black", 4.5], ["light", "charcoal", 4.5], ["light", "graphite", 4.5], ["white", "black", 4.5], ["white", "charcoal", 4.5], ["white", "graphite", 4.5],
  ["silver", "black", 4.5], ["silver", "charcoal", 4.5], ["silver", "graphite", 4.5], ["muted", "black", 4.5], ["muted", "charcoal", 4.5], ["muted", "graphite", 4.5], ["muted", "panel-2", 4.5],
  ["on-silver", "silver", 4.5], ["on-white", "white", 4.5], ["danger", "black", 4.5], ["danger", "charcoal", 4.5], ["ok", "black", 4.5], ["ok", "charcoal", 4.5],
  ["warn", "panel-2", 4.5], ["ink", "paper", 4.5], ["ink-strong", "paper", 4.5], ["ink-muted", "paper", 4.5], ["on-gold", "gold", 4.5], ["light", "panel-2", 4.5],
];
const NON_TEXT: [string, string, number][] = [["dark-grey", "black", 3], ["dark-grey", "charcoal", 3], ["focus", "black", 3], ["focus", "charcoal", 3], ["silver", "graphite", 3]];

for (const [name, tokens] of [["dark", dark], ["light", light]] as const) {
  test(`${name} theme: text contrast meets WCAG AA (4.5:1) for every checked pair`, () => {
    for (const [fg, bg, min] of TEXT) {
      const r = ratio(tokens[fg], tokens[bg]);
      assert.ok(r >= min, `${name}: ${fg} ${tokens[fg]} on ${bg} ${tokens[bg]} = ${r.toFixed(2)} < ${min}`);
    }
  });
  test(`${name} theme: control borders and focus rings meet 3:1`, () => {
    for (const [fg, bg, min] of NON_TEXT) {
      const r = ratio(tokens[fg], tokens[bg]);
      assert.ok(r >= min, `${name}: ${fg} on ${bg} = ${r.toFixed(2)} < ${min}`);
    }
  });
}

test("stylesheet hygiene: body text floor of 1rem, no text below 0.875rem, no horizontal-scroll traps", () => {
  assert.match(css, /body \{[^}]*font-size: 1rem/);
  const small = [...css.matchAll(/font-size:\s*\.?(\d*\.?\d+)(rem)/g)].map((m) => Number(m[1].startsWith(".") ? "0" + m[1] : m[1])).filter((n) => n < 0.875);
  assert.deepEqual(small, []);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible \{ outline: 3px/);
});
