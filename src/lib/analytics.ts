/**
 * Admin analytics: pure aggregation over EXISTING records (bookings, driver_ratings, drivers, payments). No data is invented, estimated or
 * back-filled: a month with no records shows zero, and a driver with no ratings shows "no ratings". Dates are bucketed in the business time
 * zone, so a ride at 11:30 PM local on the last day of a month counts in that month, across daylight-saving changes.
 */
export const MAX_ROWS = 5000; // per query; the page says so if a query hit this limit

export const monthKey = (iso: string | number | Date, tz: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).formatToParts(new Date(iso));
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
};

/** The last `n` month keys (oldest first) in the business time zone, ending with the month containing `nowMs`. */
export function lastMonths(n: number, nowMs: number, tz: string): string[] {
  const [y, m] = monthKey(nowMs, tz).split("-").map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; });
}
export const monthLabel = (key: string): string => new Date(`${key}-01T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", year: "2-digit" });

type Booking = { status: string; pickup_at: string; driver_id?: string | null };
type Rating = { driver_id: string; stars: number; created_at: string };
type Driver = { id: string; full_name: string; performance_points: number | null; is_active?: boolean | null };
type Payment = { status: string; amount_cents: number; provider: string; created_at: string };

/** Rides finished per month: bookings with status completed, by their scheduled pickup month. */
export function completedByMonth(bookings: Booking[], months: string[], tz: string) {
  const c = new Map(months.map((k) => [k, 0]));
  for (const b of bookings) if (b.status === "completed") { const k = monthKey(b.pickup_at, tz); if (c.has(k)) c.set(k, c.get(k)! + 1); }
  return months.map((k) => ({ key: k, label: monthLabel(k), value: c.get(k)! }));
}

/** Upcoming = still to be driven: confirmed or assigned (including a driver who has acknowledged) with a pickup in the future. */
export const UPCOMING_STATUSES = ["confirmed", "assigned", "getting_ready"];
export function upcomingRides(bookings: Booking[], nowMs: number) {
  const up = bookings.filter((b) => UPCOMING_STATUSES.includes(b.status) && new Date(b.pickup_at).getTime() > nowMs);
  const in7 = up.filter((b) => new Date(b.pickup_at).getTime() <= nowMs + 7 * 86400_000);
  return { total: up.length, next7Days: in7.length };
}

/** Average star rating of a driver (customer ratings only; independent of admin points) with the review count. */
export function driverTable(drivers: Driver[], ratings: Rating[], bookings: Booking[]) {
  return drivers.map((d) => {
    const mine = ratings.filter((r) => r.driver_id === d.id).map((r) => Number(r.stars));
    const avg = mine.length ? Math.round((mine.reduce((a, b) => a + b, 0) / mine.length) * 10) / 10 : null;
    return { id: d.id, name: d.full_name, active: d.is_active !== false, avgStars: avg, reviews: mine.length, points: d.performance_points == null ? null : Number(d.performance_points), completed: bookings.filter((b) => b.driver_id === d.id && b.status === "completed").length };
  }).sort((a, b) => (b.avgStars ?? -1) - (a.avgStars ?? -1) || a.name.localeCompare(b.name));
}

/** Average customer rating per month (null for a month with no ratings: shown as a gap, never as zero). */
export function ratingTrend(ratings: Rating[], months: string[], tz: string) {
  const sums = new Map(months.map((k) => [k, { sum: 0, n: 0 }]));
  for (const r of ratings) { const s = sums.get(monthKey(r.created_at, tz)); if (s) { s.sum += Number(r.stars); s.n++; } }
  return months.map((k) => { const s = sums.get(k)!; return { key: k, label: monthLabel(k), avg: s.n ? Math.round((s.sum / s.n) * 10) / 10 : null, count: s.n }; });
}

export const PAYMENT_SUCCESS = ["paid", "partially_refunded", "refunded"]; // money was really collected (a later refund does not undo that it succeeded)
export const PAYMENT_FAILURE = ["failed", "capture_failed", "authorization_expired"];
export const PAYMENT_OPEN = ["pending", "authorized", "capture_pending"];

/** Payment outcomes by status from the payments table; success rate = succeeded / (succeeded + failed), or null when there are no attempts. */
export function paymentSummary(payments: Payment[]) {
  const by = (list: string[]) => payments.filter((p) => list.includes(p.status));
  const ok = by(PAYMENT_SUCCESS), bad = by(PAYMENT_FAILURE), open = by(PAYMENT_OPEN);
  const decided = ok.length + bad.length;
  const money = (rows: Payment[]) => rows.reduce((a, p) => a + p.amount_cents, 0);
  return {
    succeeded: ok.length, failed: bad.length, open: open.length, review: payments.filter((p) => p.status === "review").length,
    collectedCents: money(by(["paid", "partially_refunded"])), heldCents: money(by(["authorized"])),
    successRate: decided ? Math.round((ok.length / decided) * 1000) / 10 : null,
    byStatus: Object.entries(payments.reduce<Record<string, number>>((a, p) => ((a[p.status] = (a[p.status] ?? 0) + 1), a), {})).sort((x, y) => y[1] - x[1]),
  };
}
