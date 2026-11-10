import "server-only";

export interface SendResult { ok: boolean; error?: string; response?: unknown }

/** SMS providers are swappable: implement this interface and register it in getSmsProvider(). */
export interface SmsProvider {
  name: string;
  isConfigured(): boolean;
  send(to: string, body: string): Promise<SendResult>;
}

export interface EmailProvider {
  name: string;
  isConfigured(): boolean;
  send(subject: string, fields: Record<string, string>): Promise<SendResult>;
}

const twilio: SmsProvider = {
  name: "twilio",
  isConfigured: () => Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER),
  async send(to, body) {
    const sid = process.env.TWILIO_ACCOUNT_SID!;
    const token = process.env.TWILIO_AUTH_TOKEN!;
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: "POST",
        headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM_NUMBER!, Body: body }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; status?: string };
      if (!res.ok) return { ok: false, error: `Twilio ${res.status}: ${data.message ?? "request failed"}`, response: data };
      return { ok: true, response: { sid: data.sid, status: data.status } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Twilio request failed" };
    }
  },
};

export function getSmsProvider(): SmsProvider | null {
  const name = (process.env.SMS_PROVIDER || "twilio").toLowerCase();
  if (name === "twilio") return twilio;
  return null; // unknown provider name: treated as not configured
}

/**
 * FormSubmit.co delivers to the recipient configured here, server-side, so the
 * address is never exposed to browsers. FORMSUBMIT_ENDPOINT_ID may hold the
 * random alias FormSubmit issues after activation (preferred over the raw email).
 */
const formsubmit: EmailProvider = {
  name: "formsubmit",
  isConfigured: () => Boolean(process.env.FORMSUBMIT_ENDPOINT_ID || process.env.FORMSUBMIT_EMAIL),
  async send(subject, fields) {
    const target = process.env.FORMSUBMIT_ENDPOINT_ID || process.env.FORMSUBMIT_EMAIL!;
    const origin = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
    try {
      const res = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(target)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Origin: origin, Referer: origin + "/" },
        body: JSON.stringify({ _subject: `[Vanta] ${subject}`, _template: "table", _captcha: "false", ...fields }),
        signal: AbortSignal.timeout(12_000),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: string | boolean; message?: string };
      const success = data.success === true || data.success === "true";
      if (!res.ok || !success) return { ok: false, error: `FormSubmit ${res.status}: ${data.message ?? "not delivered (is the address activated?)"}`, response: data };
      return { ok: true, response: data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "FormSubmit request failed" };
    }
  },
};

export const getEmailProvider = (): EmailProvider => formsubmit;
