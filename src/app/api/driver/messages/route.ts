import { json, readJson, sameOrigin } from "@/lib/http";
import { getDriverForApi } from "@/lib/driver/auth";
import { getAdminClient } from "@/lib/supabase/admin";
import { UUID_RE, listMessages, sendMessage, chatOpen } from "@/lib/chat-server";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The ride must be assigned to the signed-in driver: ownership is part of the query, so other rides look like they do not exist. */
async function ownRide(bookingId: unknown, driverId: string) {
  if (typeof bookingId !== "string" || !UUID_RE.test(bookingId)) return null;
  const db = getAdminClient();
  if (!db) return null;
  const { data } = await db.from("bookings").select("id,status,driver_id,pickup_at,confirmed_at,payment_status").eq("id", bookingId).eq("driver_id", driverId).maybeSingle();
  return data ? { db, ride: data as { id: string; status: string; driver_id: string; pickup_at: string | null; confirmed_at: string | null; payment_status: string | null } } : null;
}

export async function GET(request: Request) {
  const driver = await getDriverForApi();
  if (!driver) return json({ error: "Please sign in again." }, 401);
  const u = new URL(request.url);
  const o = await ownRide(u.searchParams.get("booking"), driver.id);
  if (!o) return json({ error: "Ride not found." }, 404);
  return json({ messages: await listMessages(o.db, o.ride.id, { role: "driver", driverId: driver.id }, u.searchParams.get("after")), open: chatOpen(o.ride) });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  const driver = await getDriverForApi();
  if (!driver) return json({ error: "Please sign in again." }, 401);
  if (!rateLimit(`chat:d:${driver.id}`, 30, 60_000)) return json({ error: "You are sending messages too quickly. Wait a moment." }, 429);
  const body = await readJson(request);
  const o = await ownRide(body?.bookingId, driver.id);
  if (!o) return json({ error: "Ride not found." }, 404);
  const r = await sendMessage(o.db, o.ride, "driver", body?.body, body?.clientId);
  return r.ok ? json({ message: r.message, duplicate: r.duplicate }) : json({ error: r.error }, r.status);
}
