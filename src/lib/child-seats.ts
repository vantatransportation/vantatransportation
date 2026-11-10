/** Child car seats: validation and pricing. Pure; amounts come from admin settings, never from the browser. */
export const SEAT_TYPES = ["rear_facing", "front_facing", "booster"] as const;
export type SeatType = (typeof SEAT_TYPES)[number];
export const SEAT_LABEL: Record<SeatType, string> = { rear_facing: "Rear-facing", front_facing: "Front-facing", booster: "Booster" };
export type ChildSeats = Record<SeatType, number>;
export const NO_SEATS: ChildSeats = { rear_facing: 0, front_facing: 0, booster: 0 };

export interface SeatSettings { oneWayCents: number; roundTripCents: number; max: number }
export const DEFAULT_SEAT_SETTINGS: SeatSettings = { oneWayCents: 1000, roundTripCents: 1500, max: 4 };

export const seatCount = (s: ChildSeats) => SEAT_TYPES.reduce((n, t) => n + s[t], 0);

/** Parses and validates a seat selection. Quantities must be whole numbers; total may not exceed the setting or the passengers. */
export function parseChildSeats(raw: unknown, passengers: number, max: number): { ok: true; seats: ChildSeats } | { ok: false; error: string } {
  const seats: ChildSeats = { ...NO_SEATS };
  if (raw && typeof raw === "object") {
    for (const t of SEAT_TYPES) {
      const v = (raw as Record<string, unknown>)[t];
      if (v === undefined || v === null || v === "") continue;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 20) return { ok: false, error: "Child seat quantities must be whole numbers." };
      seats[t] = n;
    }
  }
  const total = seatCount(seats);
  if (total > max) return { ok: false, error: `You can request up to ${max} child seats online. Please contact us for more.` };
  if (total > passengers) return { ok: false, error: "You cannot request more child seats than passengers." };
  return { ok: true, seats };
}

/**
 * The fee is per seat: one-way price per seat, or the round-trip price per seat. The round-trip rate is charged ONCE
 * per seat for the whole round trip, never once per leg. (Assumption for the business to approve.)
 */
export function childSeatFee(seats: ChildSeats, roundTrip: boolean, settings: SeatSettings) {
  const count = seatCount(seats);
  const each = roundTrip ? settings.roundTripCents : settings.oneWayCents;
  return { count, eachCents: each, totalCents: count * each };
}

export function childSeatSummary(seats: ChildSeats): string {
  return SEAT_TYPES.filter((t) => seats[t] > 0).map((t) => `${seats[t]} × ${SEAT_LABEL[t]}`).join(", ");
}
