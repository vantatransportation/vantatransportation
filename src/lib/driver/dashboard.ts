import type { DriverRide } from "@/lib/driver/rides";

const ACTIVE = ["getting_ready", "on_the_way", "arrived", "picked_up", "in_progress"];
const UPCOMING = ["assigned", "confirmed"];

/**
 * Dashboard layout rules (pure, tested): active rides in their own group; upcoming rides sorted by pickup time, earliest first, with the
 * earliest as `next`; and at most ONE completed ride in the history (the most recent). Nothing is deleted: this only limits what is shown.
 */
export function splitRides(rides: DriverRide[]) {
  const byPickup = (a: DriverRide, b: DriverRide) => new Date(a.pickupAt).getTime() - new Date(b.pickupAt).getTime();
  const active = rides.filter((r) => ACTIVE.includes(r.status)).sort(byPickup);
  const upcoming = rides.filter((r) => UPCOMING.includes(r.status)).sort(byPickup);
  const lastCompleted = rides.filter((r) => r.status === "completed").sort((a, b) => byPickup(b, a))[0] ?? null;
  return { active, next: upcoming[0] ?? null, later: upcoming.slice(1), lastCompleted };
}
