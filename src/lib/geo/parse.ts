export interface ParsedRoute {
  distanceMiles: number;
  durationMinutes: number;
  polyline: string;
  /** none = route has no tolls; known = estimate available; unavailable = tolls exist but no price. */
  toll: { status: "none" | "known" | "unavailable"; amount: number | null; currency: string | null };
}

const METERS_PER_MILE = 1609.344;

/** Parses a Google Routes API v2 computeRoutes response. Returns null if no usable route. */
export function parseRoutesResponse(json: unknown): ParsedRoute | null {
  const route = (json as { routes?: Record<string, unknown>[] } | null)?.routes?.[0];
  if (!route) return null;
  const meters = Number(route.distanceMeters);
  const seconds = Number(String(route.duration ?? "").replace(/s$/, ""));
  if (!Number.isFinite(meters) || !Number.isFinite(seconds)) return null;

  const polyline = (route.polyline as { encodedPolyline?: string } | undefined)?.encodedPolyline ?? "";
  const tollInfo = (route.travelAdvisory as { tollInfo?: { estimatedPrice?: { currencyCode?: string; units?: string; nanos?: number }[] } } | undefined)?.tollInfo;

  let toll: ParsedRoute["toll"];
  if (!tollInfo) {
    toll = { status: "none", amount: 0, currency: null };
  } else if (tollInfo.estimatedPrice && tollInfo.estimatedPrice.length > 0) {
    // Sum prices that share the first currency.
    const cur = tollInfo.estimatedPrice[0].currencyCode ?? "USD";
    const total = tollInfo.estimatedPrice
      .filter((p) => (p.currencyCode ?? "USD") === cur)
      .reduce((s, p) => s + Number(p.units ?? 0) + (p.nanos ?? 0) / 1e9, 0);
    toll = Number.isFinite(total) ? { status: "known", amount: Math.round(total * 100) / 100, currency: cur } : { status: "unavailable", amount: null, currency: null };
  } else {
    toll = { status: "unavailable", amount: null, currency: null };
  }

  return {
    distanceMiles: Math.round((meters / METERS_PER_MILE) * 10) / 10,
    durationMinutes: Math.max(1, Math.round(seconds / 60)),
    polyline,
    toll,
  };
}
