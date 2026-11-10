import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";
import { releaseAsset } from "@/lib/cloudinary";

export const runtime = "nodejs";

/** Deletes an uploaded-but-unsaved photo (admin cancelled). Refuses anything outside the vehicles folder or still in use. */
export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const body = await readJson(request);
  const id = typeof body?.publicId === "string" ? body.publicId : "";
  if (!/^[\w\-./]+$/.test(id) || id.includes("..")) return json({ error: "Invalid image." }, 422);
  const result = await releaseAsset(g.db, id);
  return json({ ok: true, result });
}
