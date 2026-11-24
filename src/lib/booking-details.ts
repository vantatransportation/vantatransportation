/** Validation for the family-focused booking fields. Pure: no framework or database imports. */
import { clean, phoneDigits, EMAIL_RE } from "./validation";

export interface PassengerInfo { name: string; phone: string; email: string | null }
export interface ContactInfo { name: string; relationship: string | null; phone: string; type: "emergency" | "secondary" }
export interface AirportInfo {
  airport: string; airline: string | null; flightNumber: string | null; direction: "arrival" | "departure";
  flightDate: string | null; flightTime: string | null; terminal: string | null; passengerName: string | null;
  pickupInstructions: string | null; meetGreet: boolean;
}
export interface BookingDetails {
  bookingFor: "self" | "other";
  passenger: PassengerInfo | null;
  luggageCount: number | null;
  assistanceNotes: string | null;
  pickupInstructions: string | null;
  contacts: ContactInfo[];
  airport: AirportInfo | null;
  policiesAcknowledged: boolean;
}
export type DetailsResult = { ok: true; details: BookingDetails } | { ok: false; error: string; fields: Record<string, string> };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const opt = (v: unknown, n: number) => clean(v, n) || null;

export function validateBookingDetails(body: Record<string, unknown>): DetailsResult {
  const fields: Record<string, string> = {};
  const bookingFor = body.bookingFor === "other" ? "other" : "self";

  let passenger: PassengerInfo | null = null;
  if (bookingFor === "other") {
    const p = obj(body.passenger);
    const name = clean(p.name, 120), phone = clean(p.phone, 30), email = clean(p.email, 200).toLowerCase();
    if (name.length < 2) fields["passenger.name"] = "Enter the passenger's full name.";
    if (phoneDigits(phone).length < 10) fields["passenger.phone"] = "Enter the passenger's phone number.";
    if (email && !EMAIL_RE.test(email)) fields["passenger.email"] = "Enter a valid email or leave it blank.";
    passenger = { name, phone, email: email || null };
  }

  let luggageCount: number | null = null;
  if (body.luggageCount !== undefined && body.luggageCount !== null && body.luggageCount !== "") {
    const n = Math.floor(Number(body.luggageCount));
    if (!Number.isFinite(n) || n < 0 || n > 50) fields.luggageCount = "Enter a number of bags between 0 and 50.";
    else luggageCount = n;
  }

  const contacts: ContactInfo[] = [];
  const rawContacts = Array.isArray(body.contacts) ? body.contacts.slice(0, 2) : [];
  rawContacts.forEach((raw, i) => {
    const c = obj(raw);
    const name = clean(c.name, 120), phone = clean(c.phone, 30);
    if (!name && !phone) return; // blank optional row
    if (name.length < 2) fields[`contacts.${i}.name`] = "Enter the contact's name.";
    if (phoneDigits(phone).length < 10) fields[`contacts.${i}.phone`] = "Enter the contact's phone number.";
    contacts.push({ name, phone, relationship: opt(c.relationship, 60), type: c.type === "secondary" ? "secondary" : "emergency" });
  });

  let airport: AirportInfo | null = null;
  const a = body.airport && typeof body.airport === "object" ? obj(body.airport) : null;
  if (a) {
    const name = clean(a.airport, 120);
    if (name.length < 2) fields["airport.airport"] = "Enter the airport.";
    const flightDate = clean(a.flightDate, 10);
    if (flightDate && !/^\d{4}-\d{2}-\d{2}$/.test(flightDate)) fields["airport.flightDate"] = "Enter a valid flight date.";
    // Airline, flight time and terminal are no longer collected from customers (no flight-data provider is configured, so nothing is looked up).
    // Existing database columns and historical airport records are untouched; new bookings simply leave them empty.
    airport = {
      airport: name, airline: null, flightNumber: opt(a.flightNumber, 12), direction: a.direction === "departure" ? "departure" : "arrival",
      flightDate: flightDate || null, flightTime: null, terminal: null, passengerName: opt(a.passengerName, 120),
      pickupInstructions: opt(a.pickupInstructions, 500), meetGreet: a.meetGreet === true,
    };
  }

  if (body.policiesAcknowledged !== true) fields.policiesAcknowledged = "Please confirm you have read the waiting-time and no-show policies.";
  if (Object.keys(fields).length) return { ok: false, error: "Check the highlighted fields.", fields };

  return {
    ok: true,
    details: {
      bookingFor, passenger, luggageCount, assistanceNotes: opt(body.assistanceNotes, 1000), pickupInstructions: opt(body.pickupInstructions, 1000),
      contacts, airport, policiesAcknowledged: true,
    },
  };
}
