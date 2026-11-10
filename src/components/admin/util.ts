export type Row = Record<string, unknown>;
export type RefOptions = Record<string, { id: string; label: string }[]>;

export function getPath(row: Row, path: string): unknown {
  let cur: unknown = row;
  for (const part of path.split(".")) {
    if (cur == null) return null;
    if (Array.isArray(cur)) cur = cur[0];
    cur = (cur as Row)[part];
  }
  return cur;
}

export const label = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function fmtDate(v: unknown, tz: string): string {
  if (!v) return "";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(d);
}

export const fmtMoney = (cents: unknown) => (cents == null || cents === "" ? "" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(cents) / 100));

/** ISO string -> value for <input type="datetime-local"> in the given time zone. */
export function isoToLocalInput(iso: unknown, tz: string): string {
  if (!iso) return "";
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Local wall-clock text in a time zone -> ISO string. */
export function localInputToIso(text: string, tz: string): string {
  if (!text) return "";
  const [date, time] = text.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(guess))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return new Date(guess - (asUtc - guess)).toISOString();
}

export async function postJson(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { error: "Network error. Check your connection and try again." } };
  }
}
