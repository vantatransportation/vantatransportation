import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Admin only: emails a driver a Supabase invitation and links the new auth user to the driver record. No password is ever shown to anyone. */
export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const body = await readJson(request);
  const driverId = typeof body?.driverId === "string" && UUID_RE.test(body.driverId) ? body.driverId : null;
  if (!driverId) return json({ error: "Missing driver." }, 400);
  const { data: d } = await g.db.from("drivers").select("id,full_name,email,user_id,is_active").eq("id", driverId).maybeSingle();
  if (!d) return json({ error: "Driver not found." }, 404);
  if (!d.is_active) return json({ error: "Activate the driver before sending an invitation." }, 422);
  if (d.user_id) return json({ error: "This driver already has an account." }, 409);
  const site = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/$/, "");
  if (!site) return json({ error: "NEXT_PUBLIC_SITE_URL is not set, so the invitation link cannot be built." }, 503);
  const inv = await g.db.auth.admin.inviteUserByEmail(d.email, { redirectTo: `${site}/driver/set-password` });
  if (inv.error || !inv.data?.user) {
    const exists = /already|registered|exists/i.test(inv.error?.message ?? "");
    console.error("[drivers/invite] failed", inv.error?.message);
    return json({ error: exists ? "That email already has a sign-in account (for example an administrator). Use a different email for the driver." : "Could not send the invitation. Check Supabase email settings." }, exists ? 409 : 502);
  }
  // Never link an administrator's account to a driver record.
  const isAdmin = await g.db.from("admin_users").select("user_id").eq("user_id", inv.data.user.id).maybeSingle();
  if (isAdmin.data) return json({ error: "That account is an administrator account and cannot be a driver." }, 409);
  const link = await g.db.from("drivers").update({ user_id: inv.data.user.id }).eq("id", driverId).is("user_id", null).select("id");
  if (link.error || !link.data?.length) return json({ error: "Could not link the account. Try again." }, 500);
  await g.db.from("activity_logs").insert({ actor_id: g.admin.id, action: "driver.invited", entity_type: "driver", entity_id: driverId, meta: {} });
  return json({ ok: true });
}
