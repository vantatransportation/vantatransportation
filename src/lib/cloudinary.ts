import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CLOUDINARY_FOLDER, isCloudinaryUrl } from "@/lib/vehicle-photo";

/** Cloudinary (vehicle photos). The API secret is read only here, on the server, and never sent to a browser. */
export const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const ALLOWED_FORMATS = "jpg,jpeg,png,webp";
export const MAX_BYTES = 8 * 1024 * 1024;

export const cloudName = () => process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME?.trim() || "";
const apiKey = () => process.env.NEXT_PUBLIC_CLOUDINARY_API_KEY?.trim() || "";
const apiSecret = () => process.env.CLOUDINARY_API_SECRET?.trim() || "";
export const cloudinaryConfigured = () => Boolean(cloudName() && apiKey() && apiSecret());

/** Cloudinary signature: SHA-1 of the alphabetically sorted "k=v&k=v" parameters followed by the API secret. */
export function signParams(params: Record<string, string | number>, secret = apiSecret()): string {
  const str = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  return createHash("sha1").update(str + secret).digest("hex");
}

/** Parameters and signature the browser needs to upload ONE image into the vehicles folder. */
export function createUploadSignature(nowSec = Math.floor(Date.now() / 1000)) {
  const params = { allowed_formats: ALLOWED_FORMATS, folder: CLOUDINARY_FOLDER, timestamp: nowSec };
  return { cloudName: cloudName(), apiKey: apiKey(), ...params, signature: signParams(params) };
}

export function validUpload(contentType: unknown, size: unknown): string | null {
  if (typeof contentType !== "string" || !ALLOWED_TYPES.includes(contentType)) return "Choose a JPG, PNG or WebP image.";
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return "The image appears to be empty.";
  if (n > MAX_BYTES) return `The image is too large. The limit is ${MAX_BYTES / 1024 / 1024} MB.`;
  return null;
}

/** An assigned photo must be an image in OUR Cloudinary account and folder. Arbitrary URLs are rejected. */
export function validPhotoRef(url: string, publicId: string): boolean {
  if (!/^[\w\-./]+$/.test(publicId) || !publicId.startsWith(`${CLOUDINARY_FOLDER}/`) || publicId.includes("..")) return false;
  const cn = cloudName();
  return isCloudinaryUrl(url, cn || undefined) && Boolean(cn) && url.includes(`/${publicId}`);
}

export async function destroyAsset(publicId: string): Promise<boolean> {
  if (!cloudinaryConfigured()) return false;
  const params = { invalidate: "true", public_id: publicId, timestamp: Math.floor(Date.now() / 1000) };
  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName()}/image/destroy`, {
      method: "POST", body: new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), api_key: apiKey(), signature: signParams(params) }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Deletes an asset only if no vehicle still references it. */
export async function releaseAsset(db: SupabaseClient, publicId: string | null | undefined): Promise<"deleted" | "in_use" | "skipped"> {
  if (!publicId || !publicId.startsWith(`${CLOUDINARY_FOLDER}/`)) return "skipped";
  const { data } = await db.from("vehicles").select("id").eq("image_public_id", publicId).limit(1);
  if (data && data.length > 0) return "in_use";
  return (await destroyAsset(publicId)) ? "deleted" : "skipped";
}

/**
 * Cross-field check for vehicle photos, run after the generic field validation. Mutates `data` so the url and
 * public id always travel together. Returns an error message, or null when fine.
 */
export function normalizePhotoFields(data: Record<string, unknown>, existing?: Record<string, unknown> | null): string | null {
  if (!("image_url" in data)) { delete data.image_public_id; return null; }
  // Unchanged photo (for example the admin edited another field): keep it even if uploads are not configured right now.
  if (existing && data.image_url === (existing.image_url ?? null) && (data.image_public_id ?? null) === (existing.image_public_id ?? null)) return null;
  const url = data.image_url;
  if (url === null) { data.image_public_id = null; return null; } // removed: back to the branded placeholder
  const publicId = typeof data.image_public_id === "string" ? data.image_public_id : "";
  if (typeof url === "string" && url.startsWith("/")) { data.image_public_id = null; return null; } // legacy local illustration
  if (typeof url !== "string" || !validPhotoRef(url, publicId)) return "The photo must be uploaded through the Cloudinary uploader into the vehicles folder.";
  return null;
}
