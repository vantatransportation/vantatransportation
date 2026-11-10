import "server-only";

/** Brevo transactional email API. Server-side only: the key is never sent to the browser. */
export const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
export const BREVO_TIMEOUT_MS = 10_000;

export interface SendResult { ok: boolean; error?: string; response?: unknown }
export interface Address { email: string; name?: string }
export interface BrevoEmail { to: Address[]; subject: string; html: string; text: string; replyTo?: Address; tags?: string[] }

export interface BrevoConfig { apiKey: string; senderEmail: string; senderName: string }

/** The sender must be a sender/domain you have verified in Brevo. Nothing is assumed or invented here. */
export function brevoConfig(): BrevoConfig | null {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  const senderEmail = process.env.BREVO_SENDER_EMAIL?.trim();
  if (!apiKey || !senderEmail) return null;
  return { apiKey, senderEmail, senderName: process.env.BREVO_SENDER_NAME?.trim() || "Vanta Transportation" };
}

export const brevoConfigured = () => brevoConfig() !== null;

export async function sendBrevoEmail(mail: BrevoEmail): Promise<SendResult> {
  const cfg = brevoConfig();
  if (!cfg) return { ok: false, error: "Brevo is not configured (BREVO_API_KEY and BREVO_SENDER_EMAIL)." };
  try {
    const res = await fetch(BREVO_ENDPOINT, {
      method: "POST",
      headers: { "api-key": cfg.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { name: cfg.senderName, email: cfg.senderEmail },
        to: mail.to, subject: mail.subject, htmlContent: mail.html, textContent: mail.text,
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
        ...(mail.tags?.length ? { tags: mail.tags } : {}),
      }),
      signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as { messageId?: string; message?: string; code?: string };
    // Brevo answers 201 with a messageId when the message is accepted for sending.
    if (!res.ok || !data.messageId) {
      return { ok: false, error: `Brevo ${res.status}: ${data.message ?? data.code ?? "message not accepted"}`, response: { code: data.code, message: data.message } };
    }
    return { ok: true, response: { messageId: data.messageId } };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, error: timedOut ? "Brevo request timed out" : e instanceof Error ? `Brevo request failed: ${e.message}` : "Brevo request failed" };
  }
}
