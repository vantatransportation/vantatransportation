import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { rateLimit } from "@/lib/rate-limit";
import { clean, EMAIL_RE, phoneDigits } from "@/lib/validation";
import { findOrCreateCustomer } from "@/lib/customers";
import { notify } from "@/lib/notify";
import { sameOrigin } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`contact:${ip}`, 5, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests. Please try again in a few minutes." }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Honeypot: real visitors never fill this hidden field. Pretend success for bots.
  if (typeof body.website === "string" && body.website.length > 0) {
    return NextResponse.json({ ok: true });
  }

  const name = clean(body.name, 120);
  const email = clean(body.email, 200).toLowerCase();
  const phone = clean(body.phone, 30);
  const subject = clean(body.subject, 150);
  const message = clean(body.message, 4000);

  const errors: Record<string, string> = {};
  if (name.length < 2) errors.name = "Enter your name.";
  if (!EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
  if (phone && phoneDigits(phone).length < 7) errors.phone = "Enter a valid phone number.";
  if (message.length < 5) errors.message = "Tell us how we can help.";
  if (Object.keys(errors).length) {
    return NextResponse.json({ error: "Check the highlighted fields.", fields: errors }, { status: 422 });
  }

  const db = getAdminClient();
  if (!db) {
    console.error("[contact] Supabase service role is not configured; submission not stored.");
    return NextResponse.json(
      { error: "Our contact form is temporarily unavailable. Please try again later." },
      { status: 503 },
    );
  }

  try {
    const customerId = await findOrCreateCustomer(db, { name, email, phone: phone || null });

    const lead = await db
      .from("leads")
      .insert({ customer_id: customerId, name, email, phone: phone || null, subject: subject || null, message, source: "contact_form" })
      .select("id")
      .single();
    if (lead.error) throw lead.error;

    await db.from("activity_logs").insert({ action: "lead.created", entity_type: "lead", entity_id: lead.data.id, meta: { source: "contact_form" } });

    // Saved first; notification failures are logged and never affect the saved record.
    await notify(db, "lead.created", { type: "lead", id: lead.data.id }, { Customer: name, Email: email, Phone: phone || undefined, Subject: subject || undefined, Message: message });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[contact] failed to store submission", err);
    return NextResponse.json({ error: "We could not save your message. Please try again." }, { status: 500 });
  }
}
