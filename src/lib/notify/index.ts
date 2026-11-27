import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildNotification, renderEmail, type EmailMessage, type NotifyEvent } from "./templates";
import { brevoConfigured, sendBrevoEmail, type SendResult } from "./brevo";
import { DEFAULT_BUSINESS_EMAIL } from "@/lib/config";
import { siteBase, trackingUrl } from "@/lib/tracking-url";

export interface ConfigWarning { channel: "email" | "maps" | "database" | "payments" | "photos"; message: string }

/** Missing credentials are reported in the admin dashboard instead of crashing anything. */
export function configWarnings(): ConfigWarning[] {
  const w: ConfigWarning[] = [];
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) w.push({ channel: "database", message: "Supabase URL or service-role key is missing. Submissions cannot be stored." });
  if (!siteBase()) w.push({ channel: "email", message: "NEXT_PUBLIC_SITE_URL is missing or points at localhost. Tracking links in emails are left out until it is set to the public https:// address of the site." });
  if (!process.env.BREVO_API_KEY) w.push({ channel: "email", message: "Email is not configured. Set BREVO_API_KEY. Emails are skipped until then (bookings and inquiries are still saved)." });
  if (!process.env.BREVO_SENDER_EMAIL) w.push({ channel: "email", message: "BREVO_SENDER_EMAIL is not set. It must be a sender or domain you have verified in Brevo." });
  if (!process.env.GOOGLE_MAPS_SERVER_API_KEY) w.push({ channel: "maps", message: "GOOGLE_MAPS_SERVER_API_KEY is missing. The fare calculator cannot route or autocomplete." });
  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) w.push({ channel: "maps", message: "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is missing. The route map will not display." });
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) w.push({ channel: "payments", message: "Online payments are off until STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set. Booking requests still work." });
  else if (!process.env.STRIPE_PUBLISHABLE_KEY && !process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) w.push({ channel: "payments", message: "STRIPE_PUBLISHABLE_KEY is missing. Customers cannot save a card at booking until it is set (the saved-card workflow needs Stripe's publishable key as well as the secret key)." });
  if (!process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || !process.env.NEXT_PUBLIC_CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) w.push({ channel: "photos", message: "Vehicle photo uploads are disabled until the three CLOUDINARY variables are set. The website shows branded placeholders meanwhile." });
  return w;
}

export const businessEmail = () => process.env.BUSINESS_NOTIFICATION_EMAIL?.trim() || DEFAULT_BUSINESS_EMAIL;

async function deliver(msg: EmailMessage): Promise<SendResult | "skipped"> {
  if (!brevoConfigured()) return "skipped";
  const to = msg.audience === "business" ? { email: businessEmail() } : msg.to;
  if (!to?.email) return "skipped";
  const { html, text } = renderEmail(msg);
  return sendBrevoEmail({ to: [to], subject: `${msg.audience === "business" ? "[Vanta] " : ""}${msg.subject}`, html, text, replyTo: msg.replyTo, tags: [msg.audience] });
}

async function attempt(db: SupabaseClient, logId: string, msg: EmailMessage, prevAttempts: number) {
  const now = new Date().toISOString();
  let result: SendResult | "skipped";
  try {
    result = await deliver(msg);
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : "Unexpected error" };
  }
  if (result === "skipped") {
    await db.from("notification_logs").update({ status: "skipped", error: "Brevo or recipient not configured", last_attempt_at: now }).eq("id", logId);
    return;
  }
  await db.from("notification_logs").update({
    status: result.ok ? "sent" : "failed", attempts: prevAttempts + 1, error: result.ok ? null : result.error ?? "Unknown error",
    provider_response: (result.response ?? null) as never, last_attempt_at: now,
  }).eq("id", logId);
  if (!result.ok) console.error("[notify] email failed:", result.error); // never logs keys or message bodies
}

/** In-dashboard alert; the admin UI turns these into native browser notifications. Written only after the record is saved. */
async function recordAdminAlert(db: SupabaseClient, event: NotifyEvent, entity: { type: string; id: string }, a: { title: string; body: string; link: string }, suffix: string) {
  const ins = await db.from("admin_notifications").insert({ event, entity_type: entity.type, entity_id: entity.id, title: a.title, body: a.body, link: a.link, dedupe_key: `${event}:${entity.id}:${suffix}` });
  if (ins.error && ins.error.code !== "23505") console.error("[notify] could not write admin alert", ins.error.message);
}

/**
 * Records the in-dashboard alert and sends the emails for an event. Never throws: the caller's data
 * is already saved. Unique dedupe keys stop duplicate alerts and duplicate emails for the same event.
 */
export async function notify(
  db: SupabaseClient, event: NotifyEvent, entity: { type: string; id: string },
  data: Record<string, string | undefined>, options: { dedupeSuffix?: string } = {},
): Promise<void> {
  try {
    const base = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/$/, "");
    // One place builds the direct tracking link for every customer email that shows a Tracking ID (callers may still pass their own).
    const code = data._trackingId ?? data["Tracking ID"];
    const _trackUrl = data._trackUrl ?? (code ? trackingUrl(code) ?? undefined : undefined);
    const built = buildNotification(event, { ...data, _trackUrl, _id: entity.id, _adminUrl: base ? `${base}/admin/${entity.type === "booking" ? "bookings" : entity.type === "lead" ? "leads" : "quotes"}/${entity.id}` : undefined });
    const suffix = options.dedupeSuffix ?? "";
    if (built.admin) await recordAdminAlert(db, event, entity, built.admin, suffix);
    for (const msg of built.emails) {
      const ins = await db.from("notification_logs").insert({
        channel: "email", event, entity_type: entity.type, entity_id: entity.id, dedupe_key: `${event}:${entity.id}:${suffix}:${msg.audience}`, status: "pending", payload: msg as never,
      }).select("id").single();
      if (ins.error) {
        if (ins.error.code !== "23505") console.error("[notify] could not write log", ins.error.message);
        continue; // 23505 = already sent/queued: duplicate suppressed
      }
      await attempt(db, ins.data.id as string, msg, 0);
    }
  } catch (e) {
    console.error("[notify] unexpected error", e instanceof Error ? e.message : e);
  }
}

/** Re-sends a failed or skipped email from its stored message. */
export async function retryNotification(db: SupabaseClient, id: string): Promise<{ ok: boolean; message: string }> {
  const { data } = await db.from("notification_logs").select("id,channel,status,attempts,payload").eq("id", id).maybeSingle();
  if (!data) return { ok: false, message: "Notification not found." };
  if (data.status === "sent") return { ok: false, message: "Already sent." };
  if (data.channel !== "email") return { ok: false, message: "SMS is no longer supported. This is a historical record." };
  const p = data.payload as Partial<EmailMessage>;
  if (!p?.subject) return { ok: false, message: "This record has no stored email content." };
  const msg: EmailMessage = { audience: p.audience ?? "business", to: p.to, replyTo: p.replyTo, subject: p.subject, heading: p.heading ?? p.subject, intro: p.intro ?? "", fields: p.fields ?? {}, ctaLabel: p.ctaLabel, ctaUrl: p.ctaUrl, footnote: p.footnote, links: p.links };
  await attempt(db, data.id, msg, data.attempts ?? 0);
  const after = await db.from("notification_logs").select("status,error").eq("id", id).single();
  return after.data?.status === "sent" ? { ok: true, message: "Sent." } : { ok: false, message: after.data?.error ?? `Status: ${after.data?.status}` };
}
