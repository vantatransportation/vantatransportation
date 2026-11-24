import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Admin-only: show or hide the star rating and the performance points on THIS driver's dashboard, independently. Data is never deleted. */
export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const body = await readJson(request);
  const id = typeof body?.driverId === "string" && UUID_RE.test(body.driverId) ? body.driverId : null;
  if (!id) return json({ error: "Missing driver." }, 400);
  const patch: Record<string, boolean> = {};
  if (typeof body?.showRating === "boolean") patch.show_rating_to_driver = body.showRating;
  if (typeof body?.showPoints === "boolean") patch.show_points_to_driver = body.showPoints;
  if (!Object.keys(patch).length) return json({ error: "Nothing to change." }, 400);
  const { data, error } = await g.db.from("drivers").update(patch).eq("id", id).select("id,show_rating_to_driver,show_points_to_driver");
  if (error || !data?.length) return json({ error: "Driver not found." }, 404);
  await g.db.from("activity_logs").insert({ actor_id: g.admin.id, action: "driver.visibility_changed", entity_type: "driver", entity_id: id, meta: patch });
  return json({ ok: true, showRating: data[0].show_rating_to_driver, showPoints: data[0].show_points_to_driver });
}
