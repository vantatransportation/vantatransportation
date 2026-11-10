/** Theme preference: Dark, Light or System (default). Pure helpers, shared by the page script, the toggle and tests. */
export type ThemePref = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";
export const THEME_KEY = "vanta-theme";

export const parsePref = (v: unknown): ThemePref => (v === "dark" || v === "light" ? v : "system");
export const resolveTheme = (pref: ThemePref, systemDark: boolean): ResolvedTheme => (pref === "system" ? (systemDark ? "dark" : "light") : pref);

type ReadStore = Pick<Storage, "getItem">;
type WriteStore = Pick<Storage, "setItem">;
export function readPref(store: ReadStore | null | undefined): ThemePref {
  try { return parsePref(store?.getItem(THEME_KEY)); } catch { return "system"; }
}
export function writePref(store: WriteStore | null | undefined, pref: ThemePref): boolean {
  try { store?.setItem(THEME_KEY, pref); return true; } catch { return false; }
}

/**
 * Runs in <head> before first paint so the right theme is applied without a flash.
 * Keep in sync with resolveTheme (a test evaluates this script against both).
 */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_KEY}");if(p!=="dark"&&p!=="light")p="system";var d=window.matchMedia("(prefers-color-scheme: dark)").matches;var t=p==="system"?(d?"dark":"light"):p;var r=document.documentElement;r.setAttribute("data-theme",t);r.setAttribute("data-theme-pref",p);r.style.colorScheme=t;}catch(e){}})();`;
