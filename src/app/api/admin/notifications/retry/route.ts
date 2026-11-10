import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";
import { retryNotification } from "@/lib/notify";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const body = await readJson(request);
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return json({ error: "Missing id." }, 400);
  const r = await retryNotification(g.db, id);
  return json(r, r.ok ? 200 : 422);
}
