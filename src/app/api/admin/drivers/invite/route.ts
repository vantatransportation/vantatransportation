import { json, readJson } from "@/lib/http";
import { guard } from "@/lib/admin/guard";
import { getPublicClient } from "@/lib/supabase/public";
import { resolveSiteOrigin } from "@/lib/site-url";
import { SET_PASSWORD_PATH } from "@/lib/driver/invite-link";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AuthErr = { message?: string; status?: number; code?: string } | null | undefined;
const rateLimited = (e: AuthErr) => e?.status === 429 || /rate.?limit/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`);
const RATE_MSG = "Supabase is limiting how many emails it sends (its built-in email service allows only a few per hour). Wait a few minutes and try again, or configure Custom SMTP in Supabase.";

/**
 * Admin only: emails a driver a Supabase sign-in link. No password is ever shown to anyone.
 *  - First time: invites the email and links the new auth user to the driver record.
 *  - Driver already linked (link expired, was used up by an email scanner, or a forgotten password): sends a fresh link.
 * The link always opens `<this site>/driver/set-password`, the page that receives the token and lets the driver choose a password.
 */
export async function POST(request: Request) {
  const g = await guard(request);
  if (g instanceof Response) return g;
  const body = await readJson(request);
  const driverId = typeof body?.driverId === "string" && UUID_RE.test(body.driverId) ? body.driverId : null;
  if (!driverId) return json({ error: "Missing driver." }, 400);
  const { data: d } = await g.db.from("drivers").select("id,full_name,email,user_id,is_active").eq("id", driverId).maybeSingle();
  if (!d) return json({ error: "Driver not found." }, 404);
  if (!d.is_active) return json({ error: "Activate the driver before sending an invitation." }, 422);
  const site = resolveSiteOrigin(request);
  if (!site) return json({ error: "NEXT_PUBLIC_SITE_URL is not set, so the invitation link cannot be built." }, 503);
  const redirectTo = `${site.origin}${SET_PASSWORD_PATH}`;
  const log = (action: string, meta: Record<string, unknown>) => g.db.from("activity_logs").insert({ actor_id: g.admin.id, action, entity_type: "driver", entity_id: driverId, meta });

  if (d.user_id) {
    // Already has an account: send a fresh link instead of refusing, otherwise one expired link locks the driver out.
    const existing = await g.db.auth.admin.getUserById(d.user_id);
    const account = existing.data?.user;
    if (existing.error || !account?.email) return json({ error: "This driver's sign-in account could not be found. Ask the developer to check the driver's linked account." }, 409);
    const isAdmin = await g.db.from("admin_users").select("user_id").eq("user_id", account.id).maybeSingle();
    if (isAdmin.data) return json({ error: "That account is an administrator account and cannot be a driver." }, 409);
    let method: "invite" | "password-setup" | null = null;
    if (!account.email_confirmed_at) {
      // Never accepted: re-send the invitation itself.
      const again = await g.db.auth.admin.inviteUserByEmail(account.email, { redirectTo });
      if (!again.error) method = "invite";
      else if (rateLimited(again.error)) return json({ error: RATE_MSG }, 429);
    }
    if (!method) {
      const anon = getPublicClient();
      if (!anon) return json({ error: "Sign-in is not configured yet." }, 503);
      const sent = await anon.auth.resetPasswordForEmail(account.email, { redirectTo });
      if (sent.error) {
        console.error("[drivers/invite] resend failed", sent.error.message);
        return rateLimited(sent.error) ? json({ error: RATE_MSG }, 429) : json({ error: "Could not send the link. Check Supabase email settings." }, 502);
      }
      method = "password-setup";
    }
    await log("driver.invite_resent", { method });
    return json({ ok: true, resent: true, method, sentTo: account.email, opensAt: redirectTo });
  }

  const inv = await g.db.auth.admin.inviteUserByEmail(d.email, { redirectTo });
  if (inv.error || !inv.data?.user) {
    const exists = /already|registered|exists/i.test(inv.error?.message ?? "");
    console.error("[drivers/invite] failed", inv.error?.message);
    if (rateLimited(inv.error)) return json({ error: RATE_MSG }, 429);
    return json({ error: exists ? "That email already has a sign-in account (for example an administrator). Use a different email for the driver." : "Could not send the invitation. Check Supabase email settings." }, exists ? 409 : 502);
  }
  // Never link an administrator's account to a driver record.
  const isAdmin = await g.db.from("admin_users").select("user_id").eq("user_id", inv.data.user.id).maybeSingle();
  if (isAdmin.data) return json({ error: "That account is an administrator account and cannot be a driver." }, 409);
  const link = await g.db.from("drivers").update({ user_id: inv.data.user.id }).eq("id", driverId).is("user_id", null).select("id");
  if (link.error || !link.data?.length) return json({ error: "Could not link the account. Try again." }, 500);
  await log("driver.invited", {});
  return json({ ok: true, sentTo: d.email, opensAt: redirectTo });
}
