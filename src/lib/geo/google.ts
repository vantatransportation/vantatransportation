import "server-only";
import { parseRoutesResponse, type ParsedRoute } from "./parse";
import type { Place, Trip } from "../fare/trip";

export const mapsConfigured = () => Boolean(process.env.GOOGLE_MAPS_SERVER_API_KEY);

export type RouteResult = { ok: true; route: ParsedRoute } | { ok: false; code: "not_configured" | "no_route" | "upstream"; message: string };

const waypoint = (p: Place) => (p.placeId ? { placeId: p.placeId } : { address: p.text });

/** Real road route via Google Routes API (not straight-line). Toll data uses the TOLLS extra computation. */
export async function computeRoute(trip: Trip, avoidTolls: boolean): Promise<RouteResult> {
  const key = process.env.GOOGLE_MAPS_SERVER_API_KEY;
  if (!key) return { ok: false, code: "not_configured", message: "The fare calculator is not configured yet." };

  const depart = Math.max(new Date(trip.pickupAtIso).getTime(), Date.now() + 60_000);
  const body = {
    origin: waypoint(trip.pickup),
    destination: waypoint(trip.dropoff),
    intermediates: trip.stops.map(waypoint),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    departureTime: new Date(depart).toISOString(),
    extraComputations: ["TOLLS"],
    routeModifiers: { avoidTolls },
    units: "IMPERIAL",
    languageCode: "en-US",
    regionCode: "US",
  };

  try {
    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.travelAdvisory.tollInfo",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      console.error("[routes] Google Routes API error", res.status, JSON.stringify(data)?.slice(0, 500));
      if (res.status === 400 || res.status === 404) {
        return { ok: false, code: "no_route", message: "We could not find a driving route between those locations. Check the addresses and try again." };
      }
      return { ok: false, code: "upstream", message: "Route calculation is temporarily unavailable. Please try again shortly." };
    }
    const route = parseRoutesResponse(data);
    if (!route) return { ok: false, code: "no_route", message: "We could not find a driving route between those locations." };
    return { ok: true, route };
  } catch (err) {
    console.error("[routes] request failed", err);
    return { ok: false, code: "upstream", message: "Route calculation is temporarily unavailable. Please try again shortly." };
  }
}

export interface Suggestion { text: string; placeId: string }

/** Address suggestions via Places API (New). Called server-side so the key stays private. */
export async function autocomplete(input: string, sessionToken: string): Promise<Suggestion[] | null> {
  const key = process.env.GOOGLE_MAPS_SERVER_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text",
      },
      body: JSON.stringify({ input, sessionToken, includedRegionCodes: ["us"] }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) {
      console.error("[places] autocomplete error", res.status);
      return [];
    }
    const data = (await res.json()) as { suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string } } }[] };
    return (data.suggestions ?? [])
      .map((s) => ({ text: s.placePrediction?.text?.text ?? "", placeId: s.placePrediction?.placeId ?? "" }))
      .filter((s) => s.text && s.placeId)
      .slice(0, 6);
  } catch (err) {
    console.error("[places] autocomplete failed", err);
    return [];
  }
}
