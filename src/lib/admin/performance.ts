import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PerfDriver } from "@/components/admin/DriverPerformance";
import { average } from "@/lib/rating-rules";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Everything the admin Performance panel needs, read with the admin client on the server. Never sent to drivers or customers. */
export async function loadPerformance(db: SupabaseClient, drivers: { id: string; name: string }[]): Promise<PerfDriver[]> {
  if (!drivers.length) return [];
  const ids = drivers.map((d) => d.id);
  const [dr, ratings, custRatings, hist] = await Promise.all([
    db.from("drivers").select("id,performance_points,show_rating_to_driver,show_points_to_driver").in("id", ids),
    db.from("driver_ratings").select("driver_id,stars,feedback,created_at,bookings(reference)").in("driver_id", ids).order("created_at", { ascending: false }).limit(2000),
    db.from("customer_ratings").select("driver_id,stars,feedback,created_at,bookings(reference)").in("driver_id", ids).order("created_at", { ascending: false }).limit(2000),
    db.from("driver_points_history").select("driver_id,previous_points,new_points,adjustment,reason,admin_email,created_at").in("driver_id", ids).order("created_at", { ascending: false }).limit(2000),
  ]);
  const ref = (r: Row) => (Array.isArray(r.bookings) ? r.bookings[0]?.reference : r.bookings?.reference) ?? null;
  return drivers.map((d) => {
    const x = ((dr.data ?? []) as Row[]).find((r) => r.id === d.id) ?? {};
    const mine = ((ratings.data ?? []) as Row[]).filter((r) => r.driver_id === d.id);
    const { avg, count } = average(mine.map((r) => Number(r.stars)));
    return {
      id: d.id, name: d.name, points: Number(x.performance_points ?? 100), showRating: x.show_rating_to_driver === true, showPoints: x.show_points_to_driver === true,
      ratingAvg: avg, ratingCount: count,
      history: ((hist.data ?? []) as Row[]).filter((h) => h.driver_id === d.id).slice(0, 8).map((h) => ({ at: h.created_at, previous: h.previous_points, next: h.new_points, adjustment: h.adjustment, reason: h.reason ?? null, admin: h.admin_email ?? null })),
      reviews: mine.slice(0, 10).map((r) => ({ at: r.created_at, stars: r.stars, feedback: r.feedback ?? null, reference: ref(r) })),
      customerRatings: ((custRatings.data ?? []) as Row[]).filter((r) => r.driver_id === d.id).slice(0, 10).map((r) => ({ at: r.created_at, stars: r.stars, feedback: r.feedback ?? null, reference: ref(r) })),
    };
  });
}
