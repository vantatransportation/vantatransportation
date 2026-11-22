export type RouteKey = "fastest" | "no_tolls";
export interface PlaceValue { text: string; placeId?: string }

export interface TripPayload {
  pickup: PlaceValue;
  dropoff: PlaceValue;
  stops: PlaceValue[];
  date: string;
  time: string;
  tripType: "distance" | "hourly";
  hours: number | null;
  passengers: number;
  promoCode: string | null;
  returnLeg?: { pickup: PlaceValue; dropoff: PlaceValue; date: string; time: string } | null;
  childSeats?: { rear_facing: number; front_facing: number; booster: number };
  /** Optional paid airport Meet & Greet. The fee comes from the selected vehicle's tier, on the server. */
  meetGreet?: boolean;
}

export interface RouteOptionDto {
  key: RouteKey; label: string; distanceMiles: number; durationMinutes: number; polyline: string;
  toll: { status: "none" | "known" | "unavailable" | "avoided"; amount: number | null };
}
export interface LineItemDto { code: string; label: string; cents: number; detail?: string }
export interface QuoteDto {
  totalCents: number; currency: string; lineItems: LineItemDto[]; tollStatus: "included" | "unavailable" | "avoided"; minimumApplied: boolean;
  roundTrip?: { discountCents: number; twoOneWayCents: number; ruleLabel: string | null; legs: { label: string; totalCents: number }[] };
}
export interface TierOptionDto { id: string; name: string; fixedPriceCents: number | null; meetGreetFeeCents: number | null }
export interface VehicleOptionDto {
  id: string; name: string; category: string; passengers: number; image: string | null; similarModels: string;
  description: string; capacityLabel: string;
  /**
   * Every service tier this vehicle is offered in, each with ITS fixed price and Meet & Greet fee, for DISPLAY. The vehicle appears
   * once here and is listed under each of these tiers by the calculator. The server recalculates everything that is charged.
   */
  tiers: TierOptionDto[];
  quotable: boolean; quotes: Partial<Record<RouteKey, QuoteDto>>;
}
export interface FareResponse {
  routes: RouteOptionDto[]; vehicles: VehicleOptionDto[]; promo: { code: string; applied: boolean; label: string | null } | null; pricingAvailable: boolean;
  /** Child seat prices (cents per seat) and the online maximum, for the calculator UI. The server prices from its own copy. */
  /** Child seat charge for the selected seats, in cents (an add-on charged online, not part of the trip estimate). */
  seatFeeCents?: number;
  /** The three service tiers with their configured fixed price and Meet & Greet fee (null = not set). */
  tiers?: TierOptionDto[];
  /** Whether airport Meet & Greet can be requested at all. */
  meetGreetEnabled?: boolean;
  seatInfo?: { oneWayCents: number; roundTripCents: number; max: number };
  /** Set when the trip may need staff review (outside the DMV or unverified region). Never blocks a request. */
  region?: { key: "dmv" | "east_coast" | "other" | "unknown"; label: string; manualReview: boolean };
}

/** Saved in sessionStorage so the booking page never asks for trip details again. */
export interface StoredTrip {
  trip: TripPayload;
  vehicleId: string;
  vehicleName: string;
  /** The service tier chosen in the calculator. The server validates the vehicle/tier pair again when the booking is created. */
  tierId?: string;
  routeKey: RouteKey;
  submissionKey: string;
  display: {
    quote: QuoteDto | null; distanceMiles: number; durationMinutes: number; routeLabel: string;
    /** What is charged online (display copy; recalculated on the server): fixed tier price + Meet & Greet + child seats. */
    online?: { tierName: string; fixedPriceCents: number | null; meetGreetCents: number; seatFeeCents: number } | null;
  };
}
export const TRIP_STORAGE_KEY = "vanta:trip";
