import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateMessage, type ChatMessage, type ChatRole } from "@/lib/chat";
import { chatWindowOpen, isOpenForDriver, rideMayProgress, type BookingStatus } from "@/lib/booking-status";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Chat is open only while ALL hold, computed on the server from the booking row: a driver is assigned; the booking is confirmed by verified payment
 * and still standing (rideMayProgress); the ride is not over; and now is within 24 hours before the CURRENT pickup time (a pickup change moves it).
 */
export const chatOpen = (b: { status: string; driver_id: string | null; pickup_at?: string | null; confirmed_at?: string | null; payment_status?: string | null }, nowMs: number = Date.now()) =>
  Boolean(b.driver_id) && rideMayProgress({ status: b.status, confirmed_at: b.confirmed_at ?? null, payment_status: b.payment_status ?? null }) && isOpenForDriver(b.status as BookingStatus) && chatWindowOpen(b.pickup_at ?? null, nowMs);

export type Scope = { role: "customer" } | { role: "driver"; driverId: string };

const toDto = (m: Row): ChatMessage => ({ id: m.id, role: m.sender_role, body: m.body, quick: Boolean(m.quick_reply), at: m.created_at });

/** Customers see the whole conversation for their booking; a driver sees only messages from their own assignment. */
export async function listMessages(db: SupabaseClient, bookingId: string, scope: Scope, afterIso?: string | null): Promise<ChatMessage[]> {
  let q = db.from("booking_messages").select("id,sender_role,body,quick_reply,created_at,driver_id").eq("booking_id", bookingId);
  if (scope.role === "driver") q = q.eq("driver_id", scope.driverId);
  const { data, error } = await q.order("created_at", { ascending: true }).limit(500);
  if (error) { console.error("[chat] list failed", error.message); return []; }
  const rows = (data ?? []) as Row[];
  return (afterIso && !Number.isNaN(Date.parse(afterIso)) ? rows.filter((m) => m.created_at > afterIso) : rows).map(toDto);
}

export type SendResult = { ok: true; message: ChatMessage; duplicate: boolean } | { ok: false; status: number; error: string };

/** Caller has ALREADY authorised the sender for this booking. Re-checks that chat is open and stores the message exactly once. */
export async function sendMessage(db: SupabaseClient, passed: { id: string; status: string; driver_id: string | null }, role: ChatRole, text: unknown, clientId: unknown): Promise<SendResult> {
  // Never trust the caller's copy of the booking: re-read the authoritative row so status, payment, driver and pickup time are current.
  const { data: fresh } = await db.from("bookings").select("id,status,driver_id,pickup_at,confirmed_at,payment_status").eq("id", passed.id).maybeSingle();
  if (!fresh || (role === "driver" && fresh.driver_id !== passed.driver_id)) return { ok: false, status: 404, error: "Not found." };
  const booking = { id: fresh.id as string, status: fresh.status as string, driver_id: (fresh.driver_id ?? null) as string | null };
  if (!chatOpen(fresh)) return { ok: false, status: 409, error: "Chat opens 24 hours before pickup and closes when the ride ends." };
  const v = validateMessage(text, role);
  if (!v.ok) return { ok: false, status: 422, error: v.error };
  if (typeof clientId !== "string" || !CLIENT_ID_RE.test(clientId)) return { ok: false, status: 400, error: "Invalid request." };
  const dedupe = `${booking.id}:${role}:${clientId}`;
  const ins = await db.from("booking_messages").insert({ booking_id: booking.id, driver_id: booking.driver_id, sender_role: role, body: v.body, quick_reply: v.quick, dedupe_key: dedupe }).select("id,sender_role,body,quick_reply,created_at").single();
  if (ins.error) {
    if (ins.error.code === "23505") {
      const ex = await db.from("booking_messages").select("id,sender_role,body,quick_reply,created_at").eq("dedupe_key", dedupe).maybeSingle();
      if (ex.data) return { ok: true, message: toDto(ex.data), duplicate: true };
    }
    console.error("[chat] insert failed", ins.error.message);
    return { ok: false, status: 500, error: "Could not send the message. Please try again." };
  }
  return { ok: true, message: toDto(ins.data), duplicate: false };
}
