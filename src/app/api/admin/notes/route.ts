import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";
import { clean } from "@/lib/validation";

export const runtime = "nodejs";
const TYPES = ["customer", "lead", "booking", "quote_request"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const body = await readJson(request);
  const entityType = String(body?.entityType ?? "");
  const entityId = String(body?.entityId ?? "");
  const text = clean(body?.body, 4000);
  if (!TYPES.includes(entityType) || !UUID_RE.test(entityId) || text.length < 1) return json({ error: "Write a note first." }, 422);
  const ins = await g.db.from("crm_notes").insert({ entity_type: entityType, entity_id: entityId, author_id: g.admin.id, body: text });
  if (ins.error) return json({ error: "The note could not be saved." }, 500);
  return json({ ok: true });
}
