/** Helpers for vehicle photos. Pure. A "real photo" is an https image (Cloudinary); legacy "/vehicles/*.svg" are illustrations. */
export const CLOUDINARY_FOLDER = "vanta/vehicles";

export const hasRealPhoto = (url: string | null | undefined): url is string => typeof url === "string" && /^https:\/\//i.test(url);

export function isCloudinaryUrl(url: string, cloudName?: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "res.cloudinary.com") return false;
    return cloudName ? u.pathname.startsWith(`/${cloudName}/`) : true;
  } catch {
    return false;
  }
}

/** Adds automatic format/quality and a crop to a Cloudinary delivery URL. Other URLs are returned unchanged. */
export function photoUrl(url: string, width: number, height: number): string {
  if (!isCloudinaryUrl(url)) return url;
  return url.replace("/upload/", `/upload/f_auto,q_auto,c_fill,g_auto,w_${width},h_${height}/`);
}
