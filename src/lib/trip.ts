import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { STATUS_LABEL, isOpenForDriver, rideMayProgress, type BookingStatus } from "@/lib/booking-status";
import { UUID_RE, chatOpen } from "@/lib/chat-server";
import { buildTimeline, firstName, normalizeTrackingCode, type TimelineStep } from "@/lib/tracking";
import { getHelpline, type Helpline } from "@/lib/helpline";
import { driverDisplayName } from "@/lib/driver/profile";
import { customerPricing, type CustomerPricing } from "@/lib/tier-pricing";
import { customerStage, type CustomerStage } from "@/lib/customer-stage";
import { loadBookingSettings } from "@/lib/policies";
import { availableProviders } from "@/lib/payment-providers";
import { publishableKey } from "@/lib/stripe";

/**
 * What a customer may see about ONE booking, reached with that booking's secret: the tracking ID (public Track page) or the
 * private link token (older emails and the pay flow). Nothing here is ever returned for any other booking.
 *
 * Driver details shown (only for an assigned, still-open ride): preferred/first name, picture, vehicle and plate. Deliberately NOT included: customer or driver phone numbers and email addresses, the driver's surname,
 * internal admin notes, other passengers, payment provider references, the payment token or any admin data.
 */
export interface TripView {
  reference: string; status: BookingStatus; statusLabel: string; headline: string; steps: TimelineStep[]; ended: boolean;
  pickupAt: string; pickup: string; dropoff: string | null; stops: string[]; passengers: number;
  vehicle: string | null; vehicleCategory: string | null; tier: string | null;
  driver: { name: string; photoUrl: string | null; vehicle: string | null; plate: string | null } | null;
  /** After the ride: whether the customer can rate the driver, and whether they already have. */
  rating: { canRate: boolean; rated: boolean };
  confirmed: boolean; paymentStatus: string; awaitingPayment: boolean;
  chatOpen: boolean; chatAvailable: boolean; terminalNote: string | null;
  helpline: Helpline | null;
  /** Token (private link) credential only: the customer-safe price (combined Trip fare, optional services, Total) and whether the Pay button should show. */
  charges: (CustomerPricing & { currency: string }) | null;
  /** PayPal is offered as an alternative to the saved card on the token page (never a payment link). */
  payable: boolean;
  /**
   * The saved-card workflow as the customer sees it. `stage` is derived from stored facts only (see customer-stage.ts). `card` is the brand and last four digits Stripe
   * reports for the card saved on THIS booking (never a card number). `canAddCard`/`canConfirm` say which button the page shows; the server re-checks everything when it is pressed.
   */
  stage: CustomerStage; card: { brand: string | null; last4: string } | null; cardAvailable: boolean; /** Stripe's publishable key (public by design); null when the card step is unavailable. */ publicKey: string | null; canAddCard: boolean; canConfirm: boolean;
}

export type Credential = { kind: "token"; token: unknown } | { kind: "code"; code: unknown };

const COLS = "id,reference,status,approved_at,customer_confirmed_at,card_flow,card_setup_at,card_brand,card_last4,pickup_at,pickup_address,dropoff_address,passengers,driver_id,payment_status,payment_released_at,confirmed_at,tier_name,online_amount_cents,meet_greet_selected,meet_greet_fee_cents,child_seat_fee_cents,currency,rejection_reason,cancellation_reason,vehicles(name,vehicle_categories(name))";
const PAID = ["paid", "deposit_paid", "partially_refunded", "refunded"];

export async function loadTrip(db: SupabaseClient, cred: Credential | string): Promise<{ id: string; view: TripView; driverId: string | null } | null> {
  const c: Credential = typeof cred === "string" ? { kind: "token", token: cred } : cred;
  let q = db.from("bookings").select(COLS);
  if (c.kind === "token") {
    if (typeof c.token !== "string" || !UUID_RE.test(c.token)) return null;
    q = q.eq("payment_token", c.token);
  } else {
    const code = normalizeTrackingCode(c.code);
    if (!code) return null;
    q = q.eq("tracking_code", code);
  }
  const { data: b } = await q.maybeSingle();
  if (!b) return null;
  const status = b.status as BookingStatus;
  const open = isOpenForDriver(status);
  let driver: TripView["driver"] = null;
  // Only a first name and the vehicle description, and only while a driver is assigned and the ride is still to be done.
  // Shown only when all three hold, from authoritative server state: a driver is assigned, the booking is confirmed, and verified payment
  // has reached a successful state (rideMayProgress needs confirmed_at AND a paid-type payment_status, which only verified payments set).
  if (b.driver_id && open && rideMayProgress({ status, confirmed_at: b.confirmed_at ?? null, payment_status: b.payment_status ?? null })) {
    const { data: d } = await db.from("drivers").select("full_name,first_name,preferred_name,vehicle_description,vehicle_plate,image_url").eq("id", b.driver_id).maybeSingle();
    const nm = d ? driverDisplayName(d) ?? firstName(d.full_name) : null;
    if (nm) driver = { name: nm, photoUrl: d?.image_url ?? null, vehicle: d?.vehicle_description ?? null, plate: d?.vehicle_plate ?? null };
  }
  const canRate = status === "completed" && Boolean(b.driver_id);
  const rated = canRate ? Boolean((await db.from("driver_ratings").select("id").eq("booking_id", b.id).maybeSingle()).data) : false;
  const stops = await db.from("booking_stops").select("position,address").eq("booking_id", b.id).order("position");
  const released = Boolean(b.payment_released_at && b.driver_id);
  const paid = PAID.includes(String(b.payment_status));
  const confirmed = Boolean(b.confirmed_at) || b.status === "confirmed"; // "confirmed" as a status is only ever set by the verified-payment path (or legacy rows)
  const hasAmount = b.online_amount_cents != null; // the tier fee and other internal components are not even read here
  const { data: lastCharge } = await db.from("payments").select("status").eq("booking_id", b.id).eq("saved_card", true).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const stage = customerStage({ ...b, latest_charge_status: lastCharge?.status ?? null });
  const settings = await loadBookingSettings(db);
  const cardAvailable = availableProviders(settings).includes("stripe") && Boolean(publishableKey()) && hasAmount;
  const paypalAvailable = availableProviders(settings).includes("paypal");
  const decide = ["approved_ready", "approved_card_needed", "payment_failed", "action_required", "processing"].includes(stage);
  const tl = buildTimeline({ status, hasDriver: Boolean(b.driver_id), released, paid, confirmed, stage });
  const veh = b.vehicles as { name?: string; vehicle_categories?: { name?: string } | null } | null;
  return {
    id: b.id, driverId: b.driver_id ?? null,
    view: {
      reference: b.reference, status, statusLabel: STATUS_LABEL[status] ?? status, headline: tl.headline, steps: tl.steps, ended: tl.ended,
      pickupAt: b.pickup_at, pickup: b.pickup_address, dropoff: b.dropoff_address ?? null,
      stops: (stops.data ?? []).map((s: Record<string, unknown>) => String(s.address)), passengers: b.passengers,
      vehicle: veh?.name ?? null, vehicleCategory: veh?.vehicle_categories?.name ?? null, tier: b.tier_name ?? null, driver, rating: { canRate, rated },
      confirmed, paymentStatus: String(b.payment_status), awaitingPayment: decide,
      chatOpen: chatOpen(b), chatAvailable: chatOpen(b),
      terminalNote: status === "rejected" ? (b.rejection_reason ?? "We were unable to accept this request.") : status === "cancelled" ? (b.cancellation_reason ?? "This booking was cancelled.") : null,
      helpline: await getHelpline(db),
      charges: (c.kind === "token" || decide || stage === "card_needed") && hasAmount ? { ...customerPricing(b.online_amount_cents, b.meet_greet_selected ? b.meet_greet_fee_cents : 0, b.child_seat_fee_cents), currency: b.currency ?? "USD" } : null,
      payable: c.kind === "token" && paypalAvailable && ["approved_ready", "approved_card_needed", "payment_failed"].includes(stage),
      stage, card: b.card_setup_at && b.card_last4 ? { brand: b.card_brand ?? null, last4: String(b.card_last4) } : null, cardAvailable, publicKey: cardAvailable ? publishableKey() : null,
      canAddCard: cardAvailable && ["card_needed", "approved_card_needed", "payment_failed"].includes(stage),
      canConfirm: cardAvailable && ["approved_ready", "payment_failed"].includes(stage) && Boolean(b.card_setup_at),
    },
  };
}
