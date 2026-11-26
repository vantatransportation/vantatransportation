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
/** ONE combined fare (tier fee + trip estimate) for a vehicle in a tier on a route. Never carries line items, rates or the tier fee. */
export interface TripFareDto {
  cents: number; currency: string; tollStatus: "included" | "unavailable" | "avoided";
  /** Round trips: the saving already included in `cents`. */
  roundTrip?: { savingsCents: number; ruleLabel: string | null };
}
export interface TierOptionDto { id: string; name: string; meetGreetFeeCents: number | null; /** Admin-written tier description. */ description?: string | null }
export interface VehicleTierDto extends TierOptionDto { tripFare: Partial<Record<RouteKey, TripFareDto>> }
export interface VehicleOptionDto {
  id: string; name: string; category: string; passengers: number; image: string | null; similarModels: string;
  description: string; capacityLabel: string;
  /** Every service tier this vehicle is offered in, each with its combined Trip fare per route and its Meet & Greet fee. The server recalculates everything that is charged. */
  tiers: VehicleTierDto[];
  quotable: boolean;
}
export interface FareResponse {
  routes: RouteOptionDto[]; vehicles: VehicleOptionDto[]; promo: { code: string; applied: boolean; label: string | null } | null; pricingAvailable: boolean;
  /** Child seat prices (cents per seat) and the online maximum, for the calculator UI. The server prices from its own copy. */
  /** Child seat charge for the selected seats, in cents (an add-on charged online, not part of the trip estimate). */
  seatFeeCents?: number;
  /** The service tiers with their Meet & Greet fee (null = not offered). The tier fixed fee is never sent to the browser. */
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
    distanceMiles: number; durationMinutes: number; routeLabel: string;
    /** Display copy (the server recalculates and the confirmation shows the server's figures): combined Trip fare, optional services, total. */
    pricing?: { tierName: string; tripFare: TripFareDto | null; meetGreetCents: number; seatFeeCents: number } | null;
  };
}
export const TRIP_STORAGE_KEY = "vanta:trip";
