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
export interface VehicleOptionDto {
  id: string; name: string; category: string; tier: string; passengers: number; image: string | null; similarModels: string;
  description: string; capacityLabel: string;
  quotable: boolean; quotes: Partial<Record<RouteKey, QuoteDto>>;
}
export interface FareResponse {
  routes: RouteOptionDto[]; vehicles: VehicleOptionDto[]; promo: { code: string; applied: boolean; label: string | null } | null; pricingAvailable: boolean;
  /** Child seat prices (cents per seat) and the online maximum, for the calculator UI. The server prices from its own copy. */
  seatInfo?: { oneWayCents: number; roundTripCents: number; max: number };
  /** Set when the trip may need staff review (outside the DMV or unverified region). Never blocks a request. */
  region?: { key: "dmv" | "east_coast" | "other" | "unknown"; label: string; manualReview: boolean };
}

/** Saved in sessionStorage so the booking page never asks for trip details again. */
export interface StoredTrip {
  trip: TripPayload;
  vehicleId: string;
  vehicleName: string;
  routeKey: RouteKey;
  submissionKey: string;
  display: { quote: QuoteDto | null; distanceMiles: number; durationMinutes: number; routeLabel: string };
}
export const TRIP_STORAGE_KEY = "vanta:trip";
