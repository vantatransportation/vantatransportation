/**
 * Builds notification content. Callers decide which fields to pass; booking alerts deliberately omit
 * phone numbers, passenger instructions and emergency contacts (staff open the admin record for those).
 */
export type NotifyEvent =
  | "booking.created" | "lead.created" | "quote.created" | "quote.responded" | "quote.revised_sent" | "booking.status_changed" | "payment.paid"
  | "booking.approved" | "booking.confirmed" | "booking.reassigned" | "booking.rejected" | "driver.assigned" | "driver.unassigned";

export interface EmailMessage {
  audience: "business" | "customer";
  to?: { email: string; name?: string };
  replyTo?: { email: string; name?: string };
  subject: string;
  heading: string;
  intro: string;
  fields: Record<string, string>;
  ctaLabel?: string;
  ctaUrl?: string;
  footnote?: string;
}
export interface AdminAlert { title: string; body: string; link: string }
export interface BuiltNotification { admin: AdminAlert | null; emails: EmailMessage[] }
type Data = Record<string, string | undefined>;

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const v = (d: Data, k: string) => d[k] ?? "";
const pick = (d: Data, keys: string[]) => Object.fromEntries(keys.filter((k) => d[k]).map((k) => [k, d[k]!]));
const withTracking = (d: Data): Data => (d._trackingId ? { ...d, "Tracking ID": d._trackingId } : d);
const customerTo = (d: Data) => (d._customerEmail ? { email: d._customerEmail, name: d._customerName } : undefined);
const driverTo = (d: Data) => (d._driverEmail ? { email: d._driverEmail, name: d._driverName } : undefined);
const STATUS_COPY: Record<string, { subject: string; intro: string }> = {
  confirmed: { subject: "Your Vanta booking is confirmed", intro: "Good news: your booking is now confirmed." },
  assigned: { subject: "A driver has been assigned to your booking", intro: "A driver or partner has been assigned to your booking." },
  cancelled: { subject: "Your Vanta booking was cancelled", intro: "Your booking has been cancelled. If you did not expect this, please contact us." },
  no_show: { subject: "Update on your Vanta booking", intro: "Your booking has been marked as a no-show because the passenger did not meet the driver at the confirmed pickup. Our no-show policy may apply. Please contact us if you have questions." },
};

export function buildNotification(event: NotifyEvent, d: Data): BuiltNotification {
  const id = d._id ?? "";
  switch (event) {
    case "booking.created": {
      const fields = pick(d, ["Reference", "Customer", "Email", "Pickup", "Stops", "Destination", "When", "Passengers", "Vehicle", "Trip type", "Estimated trip fare (information only)", "Tier", "Fixed tier price", "Meet & Greet", "Child car seats", "Online amount due", "Service region", "Needs staff review", "Requested extras", "Booking for"]);
      const cust: EmailMessage[] = d._customerEmail ? [{
        audience: "customer", to: customerTo(d), subject: `We received your booking request ${v(d, "Reference")}`,
        heading: "Booking request received",
        intro: "Thank you. This is a request, not a confirmed booking. We will review it first. No payment has been taken. If we approve it, we will email you a secure payment link, and your booking is confirmed once that payment is received.",
        fields: pick(withTracking(d), ["Reference", "Tracking ID", "When", "Pickup", "Stops", "Destination", "Vehicle", "Passengers", "Estimated trip fare (information only)", "Tier", "Fixed tier price", "Meet & Greet", "Child car seats", "Online amount due"]),
        footnote: "Keep your tracking ID private: anyone who has it can see this booking's progress. Requested services (such as airport Meet & Greet or child car seats) are not confirmed until we confirm them with you.",
        ...(d._trackUrl ? { ctaLabel: "Track your ride", ctaUrl: d._trackUrl } : {}),
      }] : [];
      return {
        admin: { title: "New booking request", body: `${v(d, "Reference")} was received. Open the dashboard to review.`, link: `/admin/bookings/${id}` },
        emails: [{ audience: "business", subject: `New booking request ${v(d, "Reference")}`, heading: "New booking request", intro: "A booking request was saved. Open the admin record for contact, passenger and emergency-contact details.", fields, ctaLabel: "Open booking", ctaUrl: d._adminUrl }, ...cust],
      };
    }
    case "lead.created":
      return {
        admin: { title: "New website inquiry", body: "A new contact inquiry was received. Open the dashboard to read it.", link: `/admin/leads/${id}` },
        emails: [{
          audience: "business", subject: `New inquiry from ${v(d, "Customer")}`, heading: "New website inquiry", intro: "Reply directly to this email to answer the customer.",
          fields: pick(d, ["Customer", "Email", "Phone", "Subject", "Message"]), replyTo: d.Email ? { email: d.Email, name: d.Customer } : undefined, ctaLabel: "Open inquiry", ctaUrl: d._adminUrl,
        }],
      };
    case "quote.created":
      return {
        admin: { title: "New quote request", body: "A customer asked for a custom quote. Open the dashboard to review.", link: `/admin/quotes/${id}` },
        emails: [{
          audience: "business", subject: `Quote request from ${v(d, "Customer")}`, heading: "New quote request", intro: "A quote request is not a confirmed booking.",
          fields: pick(d, ["Customer", "Email", "Phone", "Vehicle", "Pickup", "Destination", "When", "Service region", "Original quote", "Desired budget", "Message"]),
          replyTo: d.Email ? { email: d.Email, name: d.Customer } : undefined, ctaLabel: "Open quote request", ctaUrl: d._adminUrl,
        }],
      };
    case "quote.responded":
      return {
        admin: { title: `Quote ${v(d, "Response").toLowerCase()}`, body: "A customer responded to a revised quote. Open the dashboard to continue.", link: `/admin/quotes/${id}` },
        emails: [{ audience: "business", subject: `Customer ${v(d, "Response").toLowerCase()} the revised quote`, heading: `Quote ${v(d, "Response").toLowerCase()}`, intro: "The customer responded using their private quote link.", fields: pick(d, ["Customer", "Response", "Revised price"]), ctaLabel: "Open quote request", ctaUrl: d._adminUrl }],
      };
    case "quote.revised_sent":
      return {
        admin: null,
        emails: d._customerEmail ? [{
          audience: "customer", to: customerTo(d), subject: "Your custom quote from Vanta Transportation", heading: "Your custom quote is ready",
          intro: "We have prepared a custom quote for your trip. Review it and accept or decline using the secure link below. A quote is not a confirmed booking until we confirm it with you.",
          fields: pick(d, ["Revised price"]), ctaLabel: "Review your quote", ctaUrl: d.Link,
        }] : [],
      };
    case "payment.paid":
      return {
        admin: { title: d.Confirmed === "No" ? "Payment received: needs review" : "Payment received, booking confirmed", body: d.Confirmed === "No" ? `${v(d, "Reference")}: a verified payment arrived but the booking could not be confirmed automatically. Open the dashboard.` : `${v(d, "Reference")}: payment was verified by ${v(d, "Payment provider") || "the payment provider"} and the booking is confirmed.`, link: `/admin/bookings/${id}` },
        emails: [
          { audience: "business", subject: `Payment received ${v(d, "Reference")}`, heading: "Payment received", intro: d.Confirmed === "No" ? "The payment provider verified a payment, but this booking was not confirmed automatically (for example it was cancelled or declined in the meantime). Review it now. Nothing was refunded automatically." : "The payment provider verified this payment, so the booking is now confirmed and the customer has been sent a confirmation email.", fields: pick(d, ["Reference", "Payment provider", "Amount paid", "Payment type", "Tier", "Fixed tier price", "Meet & Greet", "Child car seats", "Payment status"]), ctaLabel: "Open booking", ctaUrl: d._adminUrl },
        ],
      };
    case "booking.confirmed":
      return {
        admin: null,
        emails: d._customerEmail ? [{
          audience: "customer", to: customerTo(d), subject: `Your Vanta booking is confirmed (${v(d, "Reference")})`, heading: "Your booking is confirmed",
          intro: "Thank you. Your payment was received and verified, and your booking is confirmed. You can follow your ride with the tracking ID below.",
          fields: pick(withTracking(d), ["Reference", "Tracking ID", "Driver", "Driver vehicle", "License plate", "Pickup", "Stops", "Destination", "When", "Vehicle", "Tier", "Amount paid", "Payment status", "Remaining online balance", "Vanta support phone"]),
          footnote: "Keep your tracking ID private: anyone who has it can see this booking's progress. For help with your ride, call Vanta support. We do not share driver or customer phone numbers; you can message your driver from the tracking page.",
          ...(d._trackUrl ? { ctaLabel: "Track your ride", ctaUrl: d._trackUrl } : {}),
        }] : [],
      };
    case "booking.approved": {
      const ctaUrl = d._payUrl ?? d["Booking page"];
      return {
        admin: null,
        emails: d._customerEmail ? [{
          audience: "customer", to: customerTo(d), subject: `Your Vanta booking is approved (${v(d, "Reference")})`, heading: "Your booking is approved",
          intro: d._payUrl ? "Good news: your booking has been approved and a driver has been assigned. To confirm it, complete payment online using the secure link below. Your booking is confirmed only after your payment is received and verified, and we will then email you your driver's name, vehicle and license plate." : "Good news: your booking has been approved and a driver has been assigned. We will arrange payment with you directly; your booking is confirmed once payment is received, and we will then email you your driver's details.",
          fields: pick(withTracking(d), ["Reference", "Tracking ID", "When", "Pickup", "Destination", "Amount due online"]),
          ...(ctaUrl ? { ctaLabel: d._payUrl ? "Pay online" : "View your booking", ctaUrl } : {}),
        }] : [],
      };
    }
    case "booking.reassigned":
      return {
        admin: null,
        emails: d._customerEmail ? [{
          audience: "customer", to: customerTo(d), subject: `Your driver has changed (${v(d, "Reference")})`, heading: "Your driver has changed",
          intro: "A different driver has been assigned to your confirmed booking. Your pickup details have not changed.",
          fields: pick(d, ["Reference", "When", "Pickup", "Destination", "Driver", "Driver vehicle", "License plate"]),
        }] : [],
      };
    case "booking.rejected":
      return {
        admin: null,
        emails: d._customerEmail ? [{
          audience: "customer", to: customerTo(d), subject: `Update on your Vanta booking request (${v(d, "Reference")})`, heading: "We could not accept your booking request",
          intro: "Unfortunately we are unable to accept this booking request. No payment is due for it.",
          fields: pick(d, ["Reference", "When", "Pickup", "Destination", "Reason"]),
        }] : [],
      };
    case "driver.assigned":
      return {
        admin: null,
        emails: d._driverEmail ? [{
          audience: "customer", to: driverTo(d), subject: `New trip assigned (${v(d, "Reference")})`, heading: "A trip has been assigned to you",
          intro: "You have been assigned to the trip below. Open the booking record for any further details.",
          fields: pick(d, ["Reference", "When", "Pickup", "Destination", "Passengers", "Luggage"]),
          ...(d._driverUrl ? { ctaLabel: "Open driver page", ctaUrl: d._driverUrl } : {}),
        }] : [],
      };
    case "driver.unassigned":
      return {
        admin: null,
        emails: d._driverEmail ? [{
          audience: "customer", to: driverTo(d), subject: `Trip no longer assigned to you (${v(d, "Reference")})`, heading: "A trip was removed from you",
          intro: "You are no longer assigned to the trip below. No action is needed.",
          fields: pick(d, ["Reference", "When"]),
        }] : [],
      };
    case "booking.status_changed": {
      const copy = STATUS_COPY[d._status ?? ""] ?? { subject: `Your booking is now ${v(d, "Status")}`, intro: `The status of your booking is now: ${v(d, "Status")}.` };
      return {
        admin: null,
        emails: d._customerEmail ? [{ audience: "customer", to: customerTo(d), subject: `${copy.subject} (${v(d, "Reference")})`, heading: copy.subject, intro: copy.intro, fields: pick(d, ["Reference", "Status", "When", "Pickup", "Destination"]) }] : [],
      };
    }
  }
}

export function renderEmail(m: EmailMessage): { html: string; text: string } {
  const rows = Object.entries(m.fields).map(([k, val]) => `<tr><td style="padding:6px 12px 6px 0;color:#8a8f98;vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:6px 0;color:#14161a;white-space:pre-wrap">${escapeHtml(val)}</td></tr>`).join("");
  const safeUrl = m.ctaUrl && /^https?:\/\//i.test(m.ctaUrl) ? m.ctaUrl : null;
  const cta = safeUrl && m.ctaLabel ? `<p style="margin:24px 0"><a href="${escapeHtml(safeUrl)}" style="background:#14161a;color:#fff;padding:12px 22px;text-decoration:none;border-radius:4px;display:inline-block">${escapeHtml(m.ctaLabel)}</a></p>` : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif"><div style="max-width:560px;margin:0 auto;padding:24px"><div style="background:#14161a;color:#fff;padding:18px 24px;letter-spacing:.2em;font-size:13px">VANTA TRANSPORTATION</div><div style="background:#fff;padding:24px"><h1 style="font-size:20px;margin:0 0 12px;color:#14161a">${escapeHtml(m.heading)}</h1><p style="color:#333;line-height:1.5">${escapeHtml(m.intro)}</p>${rows ? `<table style="border-collapse:collapse;font-size:14px;margin-top:8px">${rows}</table>` : ""}${cta}${m.footnote ? `<p style="color:#666;font-size:13px;line-height:1.5">${escapeHtml(m.footnote)}</p>` : ""}</div></div></body></html>`;
  const text = [m.heading, "", m.intro, "", ...Object.entries(m.fields).map(([k, val]) => `${k}: ${val}`), safeUrl && m.ctaLabel ? `\n${m.ctaLabel}: ${safeUrl}` : "", m.footnote ? `\n${m.footnote}` : ""].join("\n");
  return { html, text };
}
