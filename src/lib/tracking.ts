/**
 * Customer tracking. Pure (no server-only imports): used by the server, the browser and the tests.
 *
 * TWO DIFFERENT THINGS, kept apart on purpose:
 *  - booking REFERENCE ("VT-1004"): sequential and guessable. A label for humans and staff. NEVER a credential.
 *  - TRACKING ID ("TRK-7Q2MK-9XH4D-B6TWA"): random, 60+ bits, unrelated to the reference. It is the credential for the public
 *    tracking page and its chat. Everything else the customer can see is looked up by it on the server.
 */
import { AWAITING_REVIEW, STATUS_LABEL, type BookingStatus } from "@/lib/booking-status";
import { STAGE_HEADLINE, type CustomerStage } from "@/lib/customer-stage";

/** No 0/1/O/I/L, so a code read aloud or from a screenshot is hard to mistype. Database-generated codes are upper-case hex (a subset of 0-9, A-F). */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const TRACKING_CODE_RE = /^TRK-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/;

export function generateTrackingCode(bytes: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  const out: string[] = [];
  // Rejection sampling keeps every character uniformly distributed (256 is not a multiple of 31).
  while (out.length < 15) for (const b of bytes(24)) { if (b < 248 && out.length < 15) out.push(ALPHABET[b % ALPHABET.length]); }
  const c = out.join("");
  return `TRK-${c.slice(0, 5)}-${c.slice(5, 10)}-${c.slice(10, 15)}`;
}

/** Accepts what people actually type: any case, spaces or dots instead of dashes, a missing prefix, O/I/L for 0/1/1. Returns null when it cannot be a tracking ID. */
export function normalizeTrackingCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  let s = raw.toUpperCase().replace(/[\s._–—-]+/g, "");
  if (s.startsWith("TRK")) s = s.slice(3);
  s = s.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!/^[A-Z0-9]{15}$/.test(s)) return null;
  const code = `TRK-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}`;
  return TRACKING_CODE_RE.test(code) ? code : null;
}

/** "VT-1004" is a booking reference, not a tracking ID. Used only to give a helpful hint; it never looks anything up. */
export const looksLikeBookingReference = (raw: unknown) => typeof raw === "string" && /^\s*VT-?\d{2,10}\s*$/i.test(raw);

// ---------------------------------------------------------------- progress timeline

export type StepState = "done" | "current" | "upcoming";
export interface TimelineStep { key: string; label: string; state: StepState; ended?: boolean }

export interface TimelineFacts {
  status: BookingStatus; hasDriver: boolean; released: boolean; paid: boolean; confirmed: boolean;
  /** Saved-card workflow stage (customer-stage.ts). Optional so older callers keep their previous headlines. */
  stage?: CustomerStage;
}

const RIDE_RANK: Partial<Record<BookingStatus, number>> = { getting_ready: 1, on_the_way: 2, arrived: 3, picked_up: 4, in_progress: 4, completed: 5 };
const TERMINAL: Partial<Record<BookingStatus, string>> = { rejected: "Request declined", cancelled: "Booking cancelled", no_show: "Marked as no-show" };

/** Honest, fact-based progress: each step is "done" only when the underlying fact is true. Nothing is invented or interpolated. */
export function buildTimeline(f: TimelineFacts): { steps: TimelineStep[]; headline: string; ended: boolean } {
  const rank = RIDE_RANK[f.status] ?? 0;
  const reviewed = !AWAITING_REVIEW.includes(f.status) && f.status !== "rejected";
  const terminal = TERMINAL[f.status];
  const approvedBeforeEnd = reviewed && f.status !== "cancelled" ? true : f.status === "cancelled" && (f.hasDriver || f.released);

  const defs: [string, string, boolean][] = [
    ["received", "Booking request received", true],
    ["approved", reviewed && approvedBeforeEnd ? "Approved" : "Awaiting approval", reviewed && approvedBeforeEnd],
    ["payment", f.paid ? "Payment received" : "Awaiting your confirmation and payment", f.paid],
    ["confirmed", "Booking confirmed", f.confirmed],
    ["driver", "Driver assigned", f.hasDriver],
    ["getting_ready", "Driver getting ready", rank >= 1],
    ["on_the_way", "Driver on the way", rank >= 2],
    ["arrived", "Driver arrived", rank >= 3],
    ["picked_up", "Passenger picked up, ride in progress", rank >= 4],
    ["completed", "Ride completed", rank >= 5],
  ];

  if (terminal) {
    const steps: TimelineStep[] = defs.filter(([, , done]) => done).map(([key, label]) => ({ key, label, state: "done" as const }));
    steps.push({ key: f.status, label: terminal, state: "current", ended: true });
    return { steps, headline: terminal, ended: true };
  }

  // The current step is the ride step in progress, or else the first step that is not yet done.
  const firstOpen = defs.findIndex(([, , done]) => !done);
  const rideIdx = rank >= 1 ? defs.findIndex(([k]) => k === (["", "getting_ready", "on_the_way", "arrived", "picked_up", "completed"][rank])) : -1;
  const currentIdx = rideIdx >= 0 ? rideIdx : firstOpen;
  const steps: TimelineStep[] = defs.map(([key, label, done], i) => ({ key, label, state: i === currentIdx && !(rank === 5) ? "current" : done ? "done" : "upcoming" }));
  const headline = rank === 5 ? "Ride completed"
    : rank >= 1 ? ({ 1: "Your driver is getting ready", 2: "Your driver is on the way", 3: "Your driver has arrived", 4: "Ride in progress" } as Record<number, string>)[rank]
    : f.confirmed ? "Booking confirmed"
    : f.stage ? STAGE_HEADLINE[f.stage]
    : !reviewed ? "Awaiting approval"
    : f.paid ? "Payment received"
    : f.released ? "Approved: awaiting payment"
    : "Approved";
  return { steps, headline, ended: false };
}

export const publicStatusLabel = (s: BookingStatus) => STATUS_LABEL[s] ?? s;

/** Driver's first name only (never the full name, phone, email or plate on the public tracking page). */
export const firstName = (full: unknown): string | null => {
  if (typeof full !== "string") return null;
  const n = full.trim().split(/\s+/)[0];
  return n ? n.slice(0, 40) : null;
};
