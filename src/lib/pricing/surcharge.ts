/**
 * Rush-hour surcharge and tips. Pure: no framework or database imports.
 *
 * Definitions (documented business rules for this project):
 *  - BASE for both the surcharge and percentage tips is the booking's fixed tier price. Meet & Greet, child seats,
 *    waiting fees and cleanup fees are separate charges and are never part of the base. A tip is never calculated on
 *    the surcharge and the surcharge is never calculated on a tip.
 *  - The surcharge applies ONCE per booking when the journey interval [pickup, pickup + route duration] overlaps at
 *    least one configured window, evaluated in the configured business time zone (not the visitor's clock).
 *  - Windows are local wall-clock "HH:MM" start/end. A window whose end is not after its start crosses midnight.
 *  - Without a known duration the journey is treated as the single pickup instant.
 *  - Round trips: the surcharge applies once to the booking if ANY leg overlaps a window.
 */
import { zonedToUtc } from "../geo/time";

export interface RushWindow { start: string; end: string }
export interface RushSettings { enabled: boolean; percent: number; windows: RushWindow[]; timeZone: string }
/** Initial requested rule; admin can change all of it. */
export const DEFAULT_RUSH: RushSettings = {
  enabled: true, percent: 5, timeZone: "America/New_York",
  windows: [{ start: "08:00", end: "10:00" }, { start: "16:00", end: "18:00" }],
};
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const MAX_RUSH_PERCENT = 100;

/** Validates admin input. Returns an error message or null. */
export function validateRush(s: RushSettings): string | null {
  if (!Number.isFinite(s.percent) || s.percent < 0 || s.percent > MAX_RUSH_PERCENT) return `Surcharge percentage must be between 0 and ${MAX_RUSH_PERCENT}.`;
  try { new Intl.DateTimeFormat("en-US", { timeZone: s.timeZone }); } catch { return "Enter a valid time zone, for example America/New_York."; }
  if (!Array.isArray(s.windows) || s.windows.length > 12) return "Use at most 12 time windows.";
  for (const w of s.windows) {
    if (!w || !HHMM.test(w.start) || !HHMM.test(w.end)) return "Each window needs a start and end time in HH:MM format.";
    if (w.start === w.end) return "A window's start and end must differ.";
  }
  return null;
}

export interface Journey { startIso: string; durationMinutes: number | null }

const ymd = (ms: number, tz: string) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  return p; // YYYY-MM-DD
};
const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** True when the journey overlaps at least one window (any local day the journey touches, plus the day before for midnight-crossing windows). */
export function overlapsRushWindow(j: Journey, s: Pick<RushSettings, "windows" | "timeZone">): boolean {
  const start = Date.parse(j.startIso);
  if (!Number.isFinite(start)) return false;
  const dur = j.durationMinutes != null && Number.isFinite(j.durationMinutes) && j.durationMinutes > 0 ? j.durationMinutes : 0;
  const end = start + dur * 60_000;
  const first = addDays(ymd(start, s.timeZone), -1);
  const last = ymd(end, s.timeZone);
  for (let day = first; day <= last; day = addDays(day, 1)) {
    for (const w of s.windows) {
      const wStart = zonedToUtc(day, w.start, s.timeZone).getTime();
      let wEnd = zonedToUtc(day, w.end, s.timeZone).getTime();
      if (wEnd <= wStart) wEnd = zonedToUtc(addDays(day, 1), w.end, s.timeZone).getTime(); // crosses midnight
      if (dur === 0 ? start >= wStart && start < wEnd : start < wEnd && end > wStart) return true;
    }
  }
  return false;
}

export interface RushResult { applies: boolean; percent: number; cents: number }
/** Surcharge on the fixed fare, applied once. */
export function rushSurcharge(baseCents: number, journeys: Journey[], s: RushSettings): RushResult {
  const none = { applies: false, percent: s.percent, cents: 0 };
  if (!s.enabled || s.percent <= 0 || !Number.isInteger(baseCents) || baseCents <= 0) return none;
  if (!journeys.some((j) => overlapsRushWindow(j, s))) return none;
  return { applies: true, percent: s.percent, cents: Math.round((baseCents * s.percent) / 100) };
}

// ---------------------------------------------------------------- tips
export const TIP_PERCENTS = [15, 20, 25] as const;
export const MAX_TIP_CENTS = 1_000_000; // $10,000 sanity ceiling
export type TipSelection = { kind: "none" } | { kind: "percent"; percent: number } | { kind: "custom"; cents: number };
export type TipResult = { ok: true; kind: "none" | "percent" | "custom"; percent: number | null; cents: number } | { ok: false; error: string };

/** Parses the browser's tip choice (untrusted). Custom amounts arrive in dollars. */
export function parseTip(raw: unknown): TipSelection | null {
  if (raw === undefined || raw === null) return { kind: "none" };
  if (typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "none") return { kind: "none" };
  if (r.kind === "percent") return typeof r.percent === "number" ? { kind: "percent", percent: r.percent } : null;
  if (r.kind === "custom") {
    const d = typeof r.dollars === "string" ? r.dollars.trim() : typeof r.dollars === "number" ? String(r.dollars) : "";
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(d)) return null; // rejects negatives, exponents, NaN, more than 2 decimals
    const [w, f = ""] = d.split(".");
    return { kind: "custom", cents: Number(w) * 100 + Number(f.padEnd(2, "0")) };
  }
  return null;
}

/** Tip on the fixed fare only (never on the surcharge, fees or another tip). */
export function computeTip(baseCents: number, sel: TipSelection): TipResult {
  if (sel.kind === "none") return { ok: true, kind: "none", percent: null, cents: 0 };
  if (sel.kind === "percent") {
    if (!(TIP_PERCENTS as readonly number[]).includes(sel.percent)) return { ok: false, error: "Choose one of the offered tip percentages." };
    return { ok: true, kind: "percent", percent: sel.percent, cents: Math.round((baseCents * sel.percent) / 100) };
  }
  if (!Number.isInteger(sel.cents) || sel.cents < 0) return { ok: false, error: "Enter a valid tip amount." };
  if (sel.cents > MAX_TIP_CENTS) return { ok: false, error: "That tip amount is too large. Please enter a smaller amount." };
  return { ok: true, kind: "custom", percent: null, cents: sel.cents };
}
