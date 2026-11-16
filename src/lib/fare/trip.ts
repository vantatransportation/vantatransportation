import { parseChildSeats, type ChildSeats } from "@/lib/child-seats";

export interface Place { text: string; placeId?: string }
export interface Trip {
  pickup: Place;
  dropoff: Place;
  stops: Place[];
  date: string; // YYYY-MM-DD, local to the business time zone
  time: string; // HH:mm
  pickupAtIso: string;
  tripType: "distance" | "hourly";
  hours: number | null;
  passengers: number;
  promoCode: string | null;
  /** Optional return journey (round trip). Point-to-point trips only. */
  returnLeg?: ReturnLeg | null;
  /** Requested child car seats (quantities per type). The fee is computed on the server. */
  childSeats: ChildSeats;
  /** Optional paid airport Meet & Greet. Its fee is the selected tier's fee, looked up on the server. */
  meetGreet: boolean;
}

export interface ReturnLeg { pickup: Place; dropoff: Place; date: string; time: string; pickupAtIso: string }

export type TripResult = { ok: true; trip: Trip } | { ok: false; error: string };

const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

function str(v: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max) : "";
}

function place(raw: unknown): Place | null {
  const r = (raw ?? {}) as { text?: unknown; placeId?: unknown };
  const text = str(r.text, 300);
  if (text.length < 3) return null;
  const pid = typeof r.placeId === "string" && PLACE_ID_RE.test(r.placeId) ? r.placeId : undefined;
  return pid ? { text, placeId: pid } : { text };
}

/** Validates untrusted trip input. `toUtc` converts local date/time to a Date (injected for testability). */
export function validateTrip(
  raw: unknown,
  now: Date,
  toUtc: (date: string, time: string) => Date,
): TripResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pickup = place(r.pickup);
  const dropoff = place(r.dropoff);
  if (!pickup) return { ok: false, error: "Enter a pickup location." };
  if (!dropoff) return { ok: false, error: "Enter a destination." };

  const rawStops = Array.isArray(r.stops) ? r.stops : [];
  if (rawStops.length > 8) return { ok: false, error: "You can add up to 8 stops." };
  const stops: Place[] = [];
  for (const s of rawStops) {
    const p = place(s);
    if (!p) return { ok: false, error: "Each stop needs an address, or remove the empty stop." };
    stops.push(p);
  }

  const date = str(r.date, 10);
  const time = str(r.time, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return { ok: false, error: "Choose a pickup date and time." };
  }
  const when = toUtc(date, time);
  if (Number.isNaN(when.getTime())) return { ok: false, error: "Choose a valid pickup date and time." };
  if (when.getTime() < now.getTime()) return { ok: false, error: "Pickup time must be in the future." };
  if (when.getTime() > now.getTime() + 365 * 24 * 3600 * 1000) return { ok: false, error: "Pickup date is too far ahead." };

  const tripType = r.tripType === "hourly" ? "hourly" : "distance";
  let hours: number | null = null;
  if (tripType === "hourly") {
    hours = Number(r.hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24) return { ok: false, error: "Choose between 1 and 24 hours." };
  }

  const passengers = Math.floor(Number(r.passengers));
  if (!Number.isFinite(passengers) || passengers < 1 || passengers > 50) {
    return { ok: false, error: "Enter the number of passengers." };
  }

  const promo = str(r.promoCode, 40);

  const seats = parseChildSeats(r.childSeats, passengers, 10);
  if (!seats.ok) return { ok: false, error: seats.error };

  let returnLeg: ReturnLeg | null = null;
  if (r.returnLeg) {
    if (tripType === "hourly") return { ok: false, error: "Round trips are available for point-to-point rides. For hourly service, tell us your plans in a quote request." };
    const rl = (r.returnLeg ?? {}) as Record<string, unknown>;
    const rp = place(rl.pickup) ?? dropoff;
    const rd = place(rl.dropoff) ?? pickup;
    const rdate = str(rl.date, 10);
    const rtime = str(rl.time, 5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rdate) || !/^\d{2}:\d{2}$/.test(rtime)) return { ok: false, error: "Choose a return date and time." };
    const rwhen = toUtc(rdate, rtime);
    if (Number.isNaN(rwhen.getTime())) return { ok: false, error: "Choose a valid return date and time." };
    if (rwhen.getTime() <= when.getTime()) return { ok: false, error: "The return pickup must be after the outbound pickup." };
    if (rwhen.getTime() > now.getTime() + 365 * 24 * 3600 * 1000) return { ok: false, error: "Return date is too far ahead." };
    returnLeg = { pickup: rp, dropoff: rd, date: rdate, time: rtime, pickupAtIso: rwhen.toISOString() };
  }
  return {
    ok: true,
    trip: { pickup, dropoff, stops, date, time, pickupAtIso: when.toISOString(), tripType, hours, passengers, promoCode: promo || null, returnLeg, childSeats: seats.seats, meetGreet: r.meetGreet === true },
  };
}
