/**
 * Driver profile rules shared by the admin save route, the customer tracking view and the emails. Pure (no server imports).
 *
 * The profile is: first name, last name, optional preferred name, car year/make/model, license plate, location, optional
 * preferred area (city and/or ZIP) and an optional picture. The legacy `full_name` and `vehicle_description` columns are kept
 * (existing bookings, emails and assignments read them) and are DERIVED from the new fields on every admin save.
 */
type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function deriveDriverColumns(d: Row): { full_name: string; vehicle_description: string | null } {
  const full = [str(d.first_name), str(d.last_name)].filter(Boolean).join(" ");
  const car = [d.vehicle_year != null && d.vehicle_year !== "" ? String(d.vehicle_year) : "", str(d.vehicle_make), str(d.vehicle_model)].filter(Boolean).join(" ");
  return { full_name: full || str(d.full_name), vehicle_description: car || null };
}

/** Returns an error message when a required profile field is missing or invalid, otherwise null. */
export function driverProfileProblem(d: Row): string | null {
  const need: [string, string][] = [["first_name", "First name"], ["last_name", "Last name"], ["vehicle_make", "Car make"], ["vehicle_model", "Car model"], ["vehicle_plate", "License plate"], ["location", "Location"]];
  for (const [k, label] of need) if (!str(d[k])) return `${label} is required.`;
  const y = Number(d.vehicle_year);
  if (!Number.isInteger(y) || y < 1980 || y > 2100) return "Car year must be a four-digit year (1980 or later).";
  return null;
}

/** The name customers see: the preferred name when set, otherwise the first name (never the surname). */
export function driverDisplayName(d: Row): string | null {
  return str(d.preferred_name) || str(d.first_name) || (str(d.full_name).split(/\s+/)[0] ?? "") || null;
}

export function driverInitials(name: string | null): string {
  return (name ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "V";
}
