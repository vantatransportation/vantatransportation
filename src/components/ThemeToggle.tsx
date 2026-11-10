"use client";

import { useEffect, useSyncExternalStore } from "react";
import { readPref, resolveTheme, THEME_KEY, writePref, type ThemePref } from "@/lib/theme";

const CHANGE = "vanta:theme-change";
const OPTIONS: { value: ThemePref; label: string }[] = [{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }];

function apply(pref: ThemePref) {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const t = resolveTheme(pref, dark);
  const r = document.documentElement;
  r.setAttribute("data-theme", t); r.setAttribute("data-theme-pref", pref); r.style.colorScheme = t;
}
const subscribe = (cb: () => void) => {
  const onStorage = (e: StorageEvent) => { if (e.key === THEME_KEY || e.key === null) { apply(readPref(localStorage)); cb(); } };
  window.addEventListener(CHANGE, cb); window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener(CHANGE, cb); window.removeEventListener("storage", onStorage); };
};

/** Three-way theme selector (Dark, Light, System). System follows the operating system and updates live. */
export default function ThemeToggle({ className = "" }: { className?: string }) {
  const pref = useSyncExternalStore(subscribe, () => readPref(localStorage), () => "system" as ThemePref);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { if (readPref(localStorage) === "system") apply("system"); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  function choose(p: ThemePref) { writePref(localStorage, p); apply(p); window.dispatchEvent(new Event(CHANGE)); }
  return (
    <div className={`theme-toggle ${className}`} role="radiogroup" aria-label="Colour theme">
      {OPTIONS.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={pref === o.value} className={pref === o.value ? "is-on" : ""} onClick={() => choose(o.value)}>
          {pref === o.value && <span aria-hidden="true">✓ </span>}{o.label}
        </button>
      ))}
    </div>
  );
}
