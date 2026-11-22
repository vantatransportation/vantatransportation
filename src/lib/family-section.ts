/**
 * "Every Passenger Is Family." homepage section: defaults, view model and admin validation. Pure (no React/Next/server-only).
 * Content lives in site_content under the family_section.* keys (see migration 0011); the image is JSON {url, publicId, alt}.
 */
import { photoUrl, isCloudinaryUrl } from "./vehicle-photo.ts";
import { SITE_FOLDER } from "./hero.ts";

export const FAMILY_KEYS = ["enabled", "title", "subtitle", "body", "closing", "image"] as const;
export const familyKey = (k: (typeof FAMILY_KEYS)[number]) => `family_section.${k}`;
export const FAMILY_PREFIX = "family_section.";
export const FAMILY_LABELS: Record<(typeof FAMILY_KEYS)[number], string> = {
  enabled: "Family section: show on home page", title: "Family section: heading", subtitle: "Family section: subheading",
  body: "Family section: paragraph", closing: "Family section: closing line", image: "Family section: image",
};

export const FAMILY_DEFAULTS = {
  title: "Every Passenger Is Family.",
  subtitle: "We Drive Them Like They're Our Own.",
  body: "We believe every passenger deserves the care and attention we'd give our own loved ones. Whether we're transporting someone's grandparents, parents, siblings, or children, we approach every journey with patience, respect, responsibility, and an unwavering commitment to their safety.",
  closing: "Because someone is waiting for them at the other end.",
} as const;

export const FAMILY_LIMITS = { title: 120, subtitle: 160, body: 1200, closing: 200, alt: 200 } as const;

export interface FamilyView {
  title: string; subtitle: string; body: string; closing: string;
  image: { src: string; srcSet: string; alt: string } | null;
}

const str = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);

/**
 * A jsonb value that was stored as a JSON *string* ('{"url":...}', 'false') instead of an object/boolean is read as what it
 * means. Without this such a row was silently ignored: the section fell back to the Vanta mark / "shown" even though the
 * admin form (which reads the same row) displayed the saved image.
 */
function unwrap(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith("{")) {
    try { return JSON.parse(s); } catch { return v; }
  }
  return v;
}

/** Null when the section is switched off. A missing image keeps the section (the component shows a branded panel). */
export function buildFamilyView(content: Record<string, unknown>): FamilyView | null {
  if (unwrap(content[familyKey("enabled")]) === false) return null;
  const raw = unwrap(content[familyKey("image")]) as { url?: unknown; alt?: unknown } | null | undefined;
  const url = raw && typeof raw === "object" && typeof raw.url === "string" ? raw.url.trim() : "";
  const image = url && /^https:\/\//i.test(url)
    ? { src: photoUrl(url, 1200, 750), srcSet: isCloudinaryUrl(url) ? `${photoUrl(url, 640, 400)} 640w, ${photoUrl(url, 1200, 750)} 1200w` : "", alt: typeof raw?.alt === "string" ? raw.alt.trim() : "" }
    : null;
  return {
    title: str(content[familyKey("title")], FAMILY_DEFAULTS.title),
    subtitle: str(content[familyKey("subtitle")], FAMILY_DEFAULTS.subtitle),
    body: str(content[familyKey("body")], FAMILY_DEFAULTS.body),
    closing: str(content[familyKey("closing")], FAMILY_DEFAULTS.closing),
    image,
  };
}

export interface FamilyInput { enabled: boolean; title: string; subtitle: string; body: string; closing: string; image: { url: string; publicId: string; alt: string } }

/** Strict validation of the admin form. `cloud` is the configured Cloudinary cloud name; an empty image (no url) is allowed. */
export function validateFamilyInput(input: unknown, cloud: string): { ok: true; data: FamilyInput } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Missing content." };
  const v = input as Record<string, unknown>;
  // eslint-disable-next-line no-control-regex
  const clean = (x: unknown, max: number) => (typeof x === "string" ? x.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max) : "");
  const data: FamilyInput = {
    enabled: v.enabled !== false,
    title: clean(v.title, FAMILY_LIMITS.title), subtitle: clean(v.subtitle, FAMILY_LIMITS.subtitle), body: clean(v.body, FAMILY_LIMITS.body), closing: clean(v.closing, FAMILY_LIMITS.closing),
    image: { url: "", publicId: "", alt: "" },
  };
  if (!data.title) return { ok: false, error: "The heading cannot be empty." };
  const img = (v.image && typeof v.image === "object" ? v.image : {}) as Record<string, unknown>;
  const url = clean(img.url, 600), publicId = clean(img.publicId, 300);
  if (url || publicId) {
    const ok = /^[\w\-./]+$/.test(publicId) && publicId.startsWith(`${SITE_FOLDER}/`) && !publicId.includes("..") && Boolean(cloud) && isCloudinaryUrl(url, cloud) && url.includes(`/${publicId}`);
    if (!ok) return { ok: false, error: "The image must be uploaded with the Family section uploader (Cloudinary)." };
    data.image = { url, publicId, alt: clean(img.alt, FAMILY_LIMITS.alt) };
  }
  return { ok: true, data };
}

/** Current values for the admin form (stored values, falling back to the defaults for rows that do not exist yet). */
export function buildFamilyInput(content: Record<string, unknown>): FamilyInput {
  const img = unwrap(content[familyKey("image")]) as { url?: unknown; publicId?: unknown; alt?: unknown } | null | undefined;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    enabled: unwrap(content[familyKey("enabled")]) !== false,
    title: s(content[familyKey("title")]) || FAMILY_DEFAULTS.title,
    subtitle: s(content[familyKey("subtitle")]) || FAMILY_DEFAULTS.subtitle,
    body: s(content[familyKey("body")]) || FAMILY_DEFAULTS.body,
    closing: s(content[familyKey("closing")]) || FAMILY_DEFAULTS.closing,
    image: { url: s(img?.url), publicId: s(img?.publicId), alt: s(img?.alt) },
  };
}
