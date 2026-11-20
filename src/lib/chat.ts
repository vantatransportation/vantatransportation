/** Chat rules shared by the browser and the server. Pure. */
export type ChatRole = "customer" | "driver";

export const QUICK_REPLIES: Record<ChatRole, string[]> = {
  driver: ["I'm on my way.", "I've arrived at the pickup location.", "I'm waiting at the pickup point.", "Please let me know when you're outside."],
  customer: ["I'm coming outside.", "I'm at the pickup location.", "I may be a few minutes late.", "Please call me when you arrive."],
};
export const MAX_MESSAGE = 1000;

export type MessageResult = { ok: true; body: string; quick: boolean } | { ok: false; error: string };

/** Trims, strips control characters and enforces length. A quick reply is recognised only when the text is exactly one of the presets. */
export function validateMessage(raw: unknown, role: ChatRole): MessageResult {
  if (typeof raw !== "string") return { ok: false, error: "Type a message." };
  // eslint-disable-next-line no-control-regex
  const body = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!body) return { ok: false, error: "Type a message." };
  if (body.length > MAX_MESSAGE) return { ok: false, error: `Messages can be up to ${MAX_MESSAGE} characters.` };
  return { ok: true, body, quick: QUICK_REPLIES[role].includes(body) };
}

export interface ChatMessage { id: string; role: ChatRole; body: string; quick: boolean; at: string }
