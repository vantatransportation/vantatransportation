import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";
import { adjustPoints } from "@/lib/ratings";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Admin-only: adjust a driver's 0-100 performance score. Independent of star ratings; every change is logged with the admin responsible. */
export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const body = await readJson(request);
  const id = typeof body?.driverId === "string" && UUID_RE.test(body.driverId) ? body.driverId : null;
  if (!id) return json({ error: "Missing driver." }, 400);
  const r = await adjustPoints(g.db, id, { adjustment: body?.adjustment, newPoints: body?.newPoints, reason: body?.reason }, g.admin);
  if (!r.ok) return json({ error: r.error }, r.status);
  await g.db.from("activity_logs").insert({ actor_id: g.admin.id, action: "driver.points_adjusted", entity_type: "driver", entity_id: id, meta: { previous: r.previous, next: r.next } });
  return json({ ok: true, previous: r.previous, points: r.next });
}
