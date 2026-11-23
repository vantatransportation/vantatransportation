/**
 * Hero background slideshow: pure logic shared by the public hero, the admin preview, the API validation and the tests.
 * No React, Next or server-only imports.
 */
import { CLOUDINARY_FOLDER, isCloudinaryUrl } from "./vehicle-photo.ts";

export const HERO_FOLDER = "vanta/hero";
/** Family-section (and other site) images. */
export const SITE_FOLDER = "vanta/site";
export const DRIVERS_FOLDER = "vanta/drivers";
export const UPLOAD_FOLDERS = [CLOUDINARY_FOLDER, HERO_FOLDER, SITE_FOLDER, DRIVERS_FOLDER] as const;
export type UploadPurpose = "vehicles" | "hero" | "site" | "drivers";
export const parsePurpose = (v: unknown): UploadPurpose => (v === "hero" || v === "site" || v === "drivers" ? v : "vehicles");
export const folderForPurpose = (p: UploadPurpose): string => (p === "hero" ? HERO_FOLDER : p === "site" ? SITE_FOLDER : p === "drivers" ? DRIVERS_FOLDER : CLOUDINARY_FOLDER);

export const MAX_HERO_SLIDES = 12;
export const TRANSITIONS = ["fade", "slide", "zoom"] as const;
export type HeroTransition = (typeof TRANSITIONS)[number];

export interface HeroSettings {
  autoplay: boolean; transition: HeroTransition; fadeMs: number; intervalMs: number; overlayOpacity: number; pauseOnHover: boolean; showDots: boolean;
}
export const DEFAULT_HERO_SETTINGS: HeroSettings = { autoplay: true, transition: "fade", fadeMs: 1200, intervalMs: 6000, overlayOpacity: 55, pauseOnHover: true, showDots: false };
export const LIMITS = { fadeMs: [200, 5000], intervalMs: [2000, 60000], overlayOpacity: [0, 90] } as const;

export interface HeroSlideRow { id: string; image_url: string; image_public_id?: string | null; alt_text?: string | null; sort_order?: number | null; is_active?: boolean | null }

/** What the slideshow component renders. */
export interface HeroSlideView { id: string; src: string; srcSet: string | undefined; alt: string }
export interface HeroView {
  slides: HeroSlideView[];
  /** True only when there is more than one slide and autoplay is on. */
  autoplay: boolean;
  transition: HeroTransition; fadeMs: number; intervalMs: number; overlayOpacity: number; pauseOnHover: boolean; showDots: boolean;
}

export const HERO_SIZES = "100vw";
export const HERO_WIDTHS = [640, 1280, 1920] as const;

/** Cloudinary delivery URL at a given width (automatic format and quality, never upscaled). Other URLs are returned unchanged. */
export function heroImageUrl(url: string, width: number): string {
  if (!isCloudinaryUrl(url) || !url.includes("/upload/")) return url;
  const after = url.split("/upload/")[1] ?? "";
  if (/^(?:[a-z]{1,3}_[^/,]+,?)+\//i.test(after) && !/^v\d+\//.test(after)) return url; // a transformation is already present
  return url.replace("/upload/", `/upload/f_auto,q_auto,c_limit,w_${width}/`);
}
export function heroSrcSet(url: string): string | undefined {
  if (!isCloudinaryUrl(url) || !url.includes("/upload/")) return undefined;
  return HERO_WIDTHS.map((w) => `${heroImageUrl(url, w)} ${w}w`).join(", ");
}

const clampInt = (v: unknown, [lo, hi]: readonly [number, number], fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};

/** Lenient read of database values (public rendering): out-of-range values are clamped, unknown values fall back to defaults. */
export function normalizeSettings(row: Record<string, unknown> | null | undefined): HeroSettings {
  const d = DEFAULT_HERO_SETTINGS;
  if (!row) return { ...d };
  return {
    autoplay: row.autoplay === undefined || row.autoplay === null ? d.autoplay : row.autoplay === true,
    transition: (TRANSITIONS as readonly unknown[]).includes(row.transition) ? (row.transition as HeroTransition) : d.transition,
    fadeMs: clampInt(row.fade_ms, LIMITS.fadeMs, d.fadeMs),
    intervalMs: clampInt(row.interval_ms, LIMITS.intervalMs, d.intervalMs),
    overlayOpacity: clampInt(row.overlay_opacity, LIMITS.overlayOpacity, d.overlayOpacity),
    pauseOnHover: row.pause_on_hover === undefined || row.pause_on_hover === null ? d.pauseOnHover : row.pause_on_hover === true,
    showDots: row.show_dots === undefined || row.show_dots === null ? d.showDots : row.show_dots === true,
  };
}

/** Strict validation of admin input. Returns database column values or an error message. */
export function validateSettingsInput(input: unknown): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Missing settings." };
  const v = input as Record<string, unknown>;
  const int = (key: string, label: string, [lo, hi]: readonly [number, number], unit: string) => {
    const n = Number(v[key]);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < lo || n > hi) return `${label} must be a whole number from ${lo} to ${hi}${unit}.`;
    return null;
  };
  const err = int("fadeMs", "Fade duration", LIMITS.fadeMs, " ms") ?? int("intervalMs", "Display time", LIMITS.intervalMs, " ms") ?? int("overlayOpacity", "Overlay darkness", LIMITS.overlayOpacity, "");
  if (err) return { ok: false, error: err };
  if (!(TRANSITIONS as readonly unknown[]).includes(v.transition)) return { ok: false, error: "Choose a transition style: fade, slide or zoom." };
  if (Number(v.intervalMs) < Number(v.fadeMs)) return { ok: false, error: "Display time must be at least as long as the fade duration." };
  return { ok: true, data: {
    autoplay: v.autoplay === true, transition: v.transition, fade_ms: Number(v.fadeMs), interval_ms: Number(v.intervalMs),
    overlay_opacity: Number(v.overlayOpacity), pause_on_hover: v.pauseOnHover === true, show_dots: v.showDots === true,
  } };
}

/** Active slides in saved order. Null when there is nothing to show (the page then keeps the original hero). */
export function buildHeroView(settings: HeroSettings, rows: HeroSlideRow[] | null | undefined): HeroView | null {
  const slides = (rows ?? [])
    .filter((r) => r && r.is_active !== false && typeof r.image_url === "string" && /^https:\/\//i.test(r.image_url))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ((a.r.sort_order ?? 0) - (b.r.sort_order ?? 0)) || a.i - b.i)
    .map(({ r }) => ({ id: r.id, src: heroImageUrl(r.image_url, 1920), srcSet: heroSrcSet(r.image_url), alt: (r.alt_text ?? "").trim() }));
  if (!slides.length) return null;
  return { slides, autoplay: settings.autoplay && slides.length > 1, transition: settings.transition, fadeMs: settings.fadeMs, intervalMs: settings.intervalMs, overlayOpacity: settings.overlayOpacity, pauseOnHover: settings.pauseOnHover, showDots: settings.showDots };
}

/** Left-to-right overlay that keeps the hero text readable. `opacity` is 0-90 (percent). */
export function overlayGradient(opacity: number): string {
  const a = Math.min(90, Math.max(0, opacity)) / 100;
  const r = (n: number) => Math.round(n * 100) / 100;
  return `linear-gradient(90deg, rgba(0,0,0,${r(a)}) 0%, rgba(0,0,0,${r(a * 0.8)}) 55%, rgba(0,0,0,${r(a * 0.55)}) 100%)`;
}

/** Index of the next slide, skipping any in `skip`. Returns -1 when no other slide is available. */
export function nextIndex(current: number, count: number, skip: ReadonlySet<number> = new Set()): number {
  for (let step = 1; step < count; step++) {
    const c = (current + step) % count;
    if (!skip.has(c)) return c;
  }
  return -1;
}

/** Moves one item; used by drag-and-drop and the up/down buttons. Out-of-range requests return the list unchanged. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

/** A hero slide must be an image in OUR Cloudinary account, in the hero folder. */
export function validHeroRef(url: unknown, publicId: unknown, cloudName: string): boolean {
  if (typeof url !== "string" || typeof publicId !== "string" || !cloudName) return false;
  if (!/^[\w\-./]+$/.test(publicId) || !publicId.startsWith(`${HERO_FOLDER}/`) || publicId.includes("..")) return false;
  return isCloudinaryUrl(url, cloudName) && url.includes(`/${publicId}`);
}
