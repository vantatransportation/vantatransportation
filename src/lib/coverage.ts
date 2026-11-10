/**
 * Service-region classification from free-text addresses. Pure and conservative: anything it
 * cannot recognise is "unknown" and is flagged for staff review. It never rejects a trip.
 * Regions follow the business definition: DMV (primary), wider East Coast NC to NY, everything else.
 */
export type Region = "dmv" | "east_coast" | "other" | "unknown";

const DMV_ST = new Set(["DC", "MD", "VA"]);
const EAST_ST = new Set(["NC", "DE", "PA", "NJ", "NY"]);
const OTHER_ST = new Set("AL AK AZ AR CA CO CT FL GA HI ID IL IN IA KS KY LA ME MA MI MN MS MO MT NE NV NH NM ND OH OK OR RI SC SD TN TX UT VT WA WV WI WY".split(" "));

const DMV_NAMES = /\b(district of columbia|washington,?\s*d\.?c\.?|maryland|baltimore|bwi\b|dulles|reagan national|arlington|alexandria|bethesda|silver spring|annapolis|fairfax|rockville|tysons|laurel|columbia, md)\b/i;
const EAST_NAMES = /\b(north carolina|delaware|pennsylvania|new jersey|new york|philadelphia|newark|manhattan|brooklyn|queens|charlotte|raleigh|jfk|laguardia|lga|ewr)\b/i;
const FOREIGN = /\b(france|paris|england|united kingdom|london|manchester|birmingham, uk|liverpool|heathrow|gatwick|italy|spain|germany|canada|mexico)\b/i;

export function classifyPlace(text: string): Region {
  const t = text.replace(/\s+/g, " ");
  if (FOREIGN.test(t)) return "other";
  // An explicit two-letter state token ("Baltimore, MD 21201") wins over keyword guesses.
  const states = [...t.matchAll(/(?:^|[\s,])([A-Z]{2})(?=[\s,]|$)/g)].map((m) => m[1]);
  if (/west virginia/i.test(t) || states.includes("WV")) return "other";
  for (const s of states) {
    if (DMV_ST.has(s)) return "dmv";
    if (EAST_ST.has(s)) return "east_coast";
    if (OTHER_ST.has(s)) return "other";
  }
  if (/\bvirginia\b/i.test(t)) return "dmv";
  if (DMV_NAMES.test(t)) return "dmv";
  if (EAST_NAMES.test(t)) return "east_coast";
  if (/\b(california|illinois|texas|florida|georgia|san francisco|los angeles|chicago|seattle|boston|miami)\b/i.test(t)) return "other";
  return "unknown";
}

const RANK: Record<Region, number> = { dmv: 0, east_coast: 1, unknown: 2, other: 3 };

/** The trip's region is that of its least-local stop; unrecognised places make it "unknown". */
export function classifyTrip(places: string[]): Region {
  let worst: Region = "dmv";
  for (const p of places) {
    const r = classifyPlace(p);
    if (RANK[r] > RANK[worst]) worst = r;
  }
  return worst;
}

export interface Fulfilment { mode: "vanta" | "review"; requiresManualReview: boolean; reason: string | null }

/** Only DMV trips are treated as direct Vanta service; everything else is flagged for staff to confirm. */
export function fulfilmentFor(region: Region): Fulfilment {
  switch (region) {
    case "dmv": return { mode: "vanta", requiresManualReview: false, reason: null };
    case "east_coast": return { mode: "review", requiresManualReview: true, reason: "East Coast trip outside the DMV: staff to confirm whether Vanta or an approved partner will fulfil it." };
    case "other": return { mode: "review", requiresManualReview: true, reason: "Trip outside the East Coast corridor: may need an affiliate partner. Availability is not guaranteed." };
    default: return { mode: "review", requiresManualReview: true, reason: "Service region could not be determined from the addresses. Staff to verify." };
  }
}

export const REGION_LABEL: Record<Region, string> = { dmv: "DMV (primary)", east_coast: "East Coast (NC to NY)", other: "Other U.S. / Europe", unknown: "Unverified" };

const AIRPORT_RE = /airport|\b(BWI|DCA|IAD|JFK|LGA|EWR|PHL|RDU|CLT|ORF|RIC|SFO|LAX|ORD|CDG|LHR|LGW)\b/i;
export const looksLikeAirport = (text: string) => AIRPORT_RE.test(text);
