/**
 * Helpers for vehicle photos. Pure (safe in browser and server).
 *
 * A saved photo can be: a Cloudinary https URL (current uploader), another https URL (for example Supabase Storage),
 * or a legacy local path under /public ("/vehicles/photo.jpg"). Legacy local ILLUSTRATIONS (.svg, the seed data's
 * generic sedan/suv/van drawings) are deliberately not treated as photos: they would show a different vehicle.
 */
export const CLOUDINARY_FOLDER = "vanta/vehicles";

const RASTER = /\.(jpe?g|png|webp|avif|gif)(\?.*)?$/i;

/** Normalises whatever is stored in vehicles.image_url into a usable src, or null when there is no real photo. */
export function resolvePhotoSrc(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^https:\/\//i.test(s)) return s;
  if (/^http:\/\//i.test(s)) return /^http:\/\/res\.cloudinary\.com\//i.test(s) ? s.replace(/^http:/i, "https:") : null; // plain http is blocked as mixed content
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/") && !s.startsWith("//") && !s.includes("..") && RASTER.test(s)) return s; // legacy local photo in /public
  return null;
}

export const hasRealPhoto = (url: string | null | undefined): url is string => resolvePhotoSrc(url) !== null;

export function isCloudinaryUrl(url: string, cloudName?: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "res.cloudinary.com") return false;
    return cloudName ? u.pathname.toLowerCase().startsWith(`/${cloudName.toLowerCase()}/`) : true;
  } catch {
    return false;
  }
}

/** Adds automatic format/quality and a crop to a Cloudinary delivery URL (only once). Other URLs are returned unchanged. */
export function photoUrl(url: string, width: number, height: number): string {
  if (!isCloudinaryUrl(url) || !url.includes("/upload/")) return url;
  const after = url.split("/upload/")[1] ?? "";
  if (/^(?:[a-z]{1,3}_[^/,]+,?)+\//i.test(after) && !/^v\d+\//.test(after)) return url; // a transformation is already present
  return url.replace("/upload/", `/upload/f_auto,q_auto,c_fill,g_auto,w_${width},h_${height}/`);
}

/** Server-side diagnostic: one line per problem, never includes secrets. */
export function describePhotoProblem(raw: unknown): string | null {
  if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) return null; // genuinely no photo
  if (resolvePhotoSrc(raw)) return null;
  if (typeof raw === "string" && /\.svg(\?.*)?$/i.test(raw)) return "legacy illustration (svg) is shown as a placeholder by design";
  return `unsupported image value (${typeof raw === "string" ? raw.slice(0, 60) : typeof raw})`;
}
