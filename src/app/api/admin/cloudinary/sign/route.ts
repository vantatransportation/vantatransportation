import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";
import { getAdminForApi } from "@/lib/admin/auth";
import { cloudinaryConfigured, createUploadSignature, validUpload } from "@/lib/cloudinary";

export const runtime = "nodejs";

/** Issues a short-lived signed upload for ONE image, only to a signed-in admin. There is no unsigned public upload. */
export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  if (!cloudinaryConfigured()) return json({ error: "Cloudinary is not configured. Set NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME, NEXT_PUBLIC_CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.", code: "not_configured" }, 503);
  const body = await readJson(request);
  const problem = validUpload(body?.contentType, body?.size);
  if (problem) return json({ error: problem }, 422);
  return json({ ok: true, ...createUploadSignature() });
}

/** Lets the admin UI show a configuration message before anyone tries to upload. Reveals no credentials. */
export async function GET() {
  if (!(await getAdminForApi())) return json({ error: "Please sign in again." }, 401);
  return json({ configured: cloudinaryConfigured() });
}
