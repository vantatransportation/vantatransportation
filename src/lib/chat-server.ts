import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateMessage, type ChatMessage, type ChatRole } from "@/lib/chat";
import { chatAllowedForStatus, isOpenForDriver, type BookingStatus } from "@/lib/booking-status";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Chat is open only while a driver is assigned AND has started the ride or is on the way (until the ride ends). Enforced for every read-for-send and send, for both roles. */
export const chatOpen = (b: { status: string; driver_id: string | null }) => Boolean(b.driver_id) && chatAllowedForStatus(b.status) && isOpenForDriver(b.status as BookingStatus);

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
export async function sendMessage(db: SupabaseClient, booking: { id: string; status: string; driver_id: string | null }, role: ChatRole, text: unknown, clientId: unknown): Promise<SendResult> {
  if (!chatOpen(booking)) return { ok: false, status: 409, error: "Chat opens once your driver has started the ride or is on the way, and closes when the ride ends." };
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
