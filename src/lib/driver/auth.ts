import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAdminClient } from "@/lib/supabase/admin";

/** Separate cookies from the admin session: signing in as a driver never grants admin access, and vice versa. */
export const DRIVER_ACCESS_COOKIE = "vd_at";
export const DRIVER_REFRESH_COOKIE = "vd_rt";

export interface DriverUser { id: string; userId: string; name: string; email: string; phone: string | null; plate: string | null }
export type DriverState = { status: "ok"; driver: DriverUser } | { status: "expired" } | { status: "none" };

/** Valid Supabase session AND a drivers row linked to that user AND the driver is active. Deactivating a driver cuts access immediately. */
export async function getDriverState(): Promise<DriverState> {
  const store = await cookies();
  const token = store.get(DRIVER_ACCESS_COOKIE)?.value;
  const db = getAdminClient();
  if (!db) return { status: "none" };
  const refreshable = store.get(DRIVER_REFRESH_COOKIE)?.value ? ({ status: "expired" } as const) : ({ status: "none" } as const);
  if (!token) return refreshable;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return refreshable;
  const { data: d } = await db.from("drivers").select("id,user_id,full_name,email,phone,vehicle_plate,is_active").eq("user_id", data.user.id).maybeSingle();
  if (!d || d.is_active === false) return { status: "none" };
  return { status: "ok", driver: { id: d.id, userId: d.user_id, name: d.full_name, email: d.email, phone: d.phone ?? null, plate: d.vehicle_plate ?? null } };
}

export async function getDriverForApi(): Promise<DriverUser | null> {
  const s = await getDriverState();
  return s.status === "ok" ? s.driver : null;
}

export async function requireDriver(): Promise<DriverUser> {
  const s = await getDriverState();
  if (s.status === "ok") return s.driver;
  if (s.status === "expired") redirect("/api/driver/refresh");
  redirect("/driver/login");
}
