import { json } from "@/lib/http";
import { guard } from "@/lib/admin/guard";

export const runtime = "nodejs";
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return json({ error: "Choose an image to upload." }, 400);
  const ext = TYPES[file.type];
  if (!ext) return json({ error: "Upload a PNG, JPG or WebP image." }, 415);
  if (file.size > 5 * 1024 * 1024) return json({ error: "Images must be 5 MB or smaller." }, 413);

  const path = `uploads/${crypto.randomUUID()}.${ext}`;
  const up = await g.db.storage.from("site-images").upload(path, Buffer.from(await file.arrayBuffer()), { contentType: file.type, upsert: false });
  if (up.error) {
    console.error("[upload]", up.error);
    return json({ error: "Upload failed. Check that the site-images storage bucket exists (run migration 0002)." }, 500);
  }
  const { data } = g.db.storage.from("site-images").getPublicUrl(path);
  return json({ ok: true, url: data.publicUrl });
}
