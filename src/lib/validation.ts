/** Strip control characters and trim. React escapes output; email templates must escape HTML too. */
export function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}
