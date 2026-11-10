/**
 * Declarative definitions for the admin dashboard. The same definitions drive the
 * forms (client) and the server-side validation/whitelisting of writes, so the
 * browser can only change columns listed here.
 */
export type FieldType = "text" | "textarea" | "number" | "money" | "bool" | "select" | "datetime" | "image" | "photo" | "ref" | "tags";

export interface Field {
  name: string;
  label: string;
  type: FieldType;
  options?: string[];
  /** Resource slug whose rows supply the choices (type "ref"). */
  ref?: string;
  required?: boolean;
  help?: string;
  step?: number;
  /** Not rendered as an input; carried alongside another field (for example a photo's Cloudinary public id). */
  hidden?: boolean;
  /** For type "photo": the field that stores the Cloudinary public id. */
  companion?: string;
}

export interface Column {
  label: string;
  path: string;
  kind?: "text" | "bool" | "money" | "date" | "status";
}

export interface Resource {
  slug: string;
  table: string;
  title: string;
  singular: string;
  select: string;
  orderBy: string;
  ascending?: boolean;
  fields: Field[];
  columns: Column[];
  canCreate: boolean;
  canDelete: boolean;
  sortable?: boolean;
  filterField?: string;
  searchPaths?: string[];
  detailHref?: string;
  /** Adds a button that stamps the field with the current time (e.g. mark follow-up complete). */
  rowAction?: { label: string; field: string };
  /** Builds the label shown for this resource in ref dropdowns. Server only. */
  refLabel?: (row: Record<string, unknown>) => string;
}

export type ClientResource = Omit<Resource, "refLabel" | "select" | "orderBy" | "table">;

export const BOOKING_STATUSES = ["new_request", "pending_confirmation", "confirmed", "assigned", "in_progress", "completed", "cancelled", "no_show"];
export const LEAD_STATUSES = ["new", "contacted", "follow_up", "converted", "not_interested", "closed"];
export const QUOTE_STATUSES = ["new", "reviewing", "revised_sent", "accepted", "rejected", "closed"];

const nested = (row: Record<string, unknown>, key: string): string => {
  const o = row[key] as { name?: string } | null | undefined;
  return o?.name ?? "";
};

export const resources: Record<string, Resource> = {
  categories: {
    slug: "categories", table: "vehicle_categories", title: "Vehicle categories", singular: "category",
    select: "*", orderBy: "sort_order", canCreate: true, canDelete: true, sortable: true,
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "slug", label: "URL slug", type: "text", help: "Leave blank to generate from the name." },
      { name: "capacity_label", label: "Capacity label", type: "text", help: "For example: 11–14 passengers" },
      { name: "description", label: "Description", type: "textarea" },
      { name: "image_url", label: "Image", type: "image" },
      { name: "is_active", label: "Shown on website", type: "bool" },
    ],
    columns: [{ label: "Name", path: "name" }, { label: "Capacity", path: "capacity_label" }, { label: "Active", path: "is_active", kind: "bool" }],
    refLabel: (r) => String(r.name ?? ""),
  },
  tiers: {
    slug: "tiers", table: "vehicle_tiers", title: "Vehicle tiers (Business Class / First Class)", singular: "tier",
    select: "*", orderBy: "sort_order", canCreate: true, canDelete: true, sortable: true,
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "slug", label: "URL slug", type: "text", help: "Leave blank to generate from the name." },
      { name: "description", label: "Description", type: "textarea" },
      { name: "is_active", label: "In use", type: "bool" },
    ],
    columns: [{ label: "Name", path: "name" }, { label: "Description", path: "description" }, { label: "Active", path: "is_active", kind: "bool" }],
    refLabel: (r) => String(r.name ?? ""),
  },
  vehicles: {
    slug: "vehicles", table: "vehicles", title: "Vehicles", singular: "vehicle",
    select: "*, vehicle_categories(name, capacity_label), vehicle_tiers(name)", orderBy: "sort_order", canCreate: true, canDelete: true, sortable: true,
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "slug", label: "URL slug", type: "text", help: "Leave blank to generate from the name." },
      { name: "category_id", label: "Category", type: "ref", ref: "categories", required: true },
      { name: "tier_id", label: "Tier", type: "ref", ref: "tiers" },
      { name: "similar_models", label: "Similar models", type: "text" },
      { name: "description", label: "Description", type: "textarea" },
      { name: "features", label: "Features", type: "tags", help: "One per line or comma separated." },
      { name: "passenger_capacity", label: "Maximum passengers", type: "number", required: true, help: "The most passengers this vehicle can carry. The server refuses bookings above it. The range shown to customers (for example 6–7 passengers) is set on the category." },
      { name: "luggage_capacity", label: "Luggage capacity", type: "number" },
      { name: "image_url", label: "Vehicle photo", type: "photo", companion: "image_public_id", help: "Shown on vehicle cards and in the fare calculator. Without a photo, a branded placeholder is shown." },
      { name: "image_public_id", label: "Photo ID", type: "text", hidden: true },
      { name: "is_active", label: "Shown on website", type: "bool" },
      { name: "is_available", label: "Available to book", type: "bool" },
    ],
    columns: [
      { label: "Vehicle", path: "name" }, { label: "Category", path: "vehicle_categories.name" }, { label: "Tier", path: "vehicle_tiers.name" },
      { label: "Capacity range", path: "vehicle_categories.capacity_label" }, { label: "Max seats", path: "passenger_capacity" }, { label: "Shown", path: "is_active", kind: "bool" }, { label: "Available", path: "is_available", kind: "bool" },
    ],
    refLabel: (r) => String(r.name ?? ""),
  },
  standards: {
    slug: "standards", table: "vehicle_standards", title: "Vehicle standards", singular: "standard",
    select: "*", orderBy: "sort_order", canCreate: true, canDelete: true, sortable: true,
    fields: [
      { name: "title", label: "Standard", type: "text", required: true },
      { name: "description", label: "Description", type: "textarea" },
      { name: "is_active", label: "Shown on website", type: "bool" },
    ],
    columns: [{ label: "Standard", path: "title" }, { label: "Description", path: "description" }, { label: "Shown", path: "is_active", kind: "bool" }],
  },
  faqs: {
    slug: "faqs", table: "faqs", title: "FAQs", singular: "FAQ",
    select: "*", orderBy: "sort_order", canCreate: true, canDelete: true, sortable: true,
    fields: [
      { name: "question", label: "Question", type: "text", required: true },
      { name: "answer", label: "Answer", type: "textarea", required: true },
      { name: "is_active", label: "Shown on website", type: "bool" },
    ],
    columns: [{ label: "Question", path: "question" }, { label: "Shown", path: "is_active", kind: "bool" }],
  },
  promotions: {
    slug: "promotions", table: "promotions", title: "Promotions", singular: "promotion",
    select: "*", orderBy: "created_at", ascending: false, canCreate: true, canDelete: true,
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "description", label: "Description", type: "textarea" },
      { name: "image_url", label: "Image", type: "image" },
      { name: "cta_text", label: "Button text", type: "text" },
      { name: "cta_url", label: "Button destination", type: "text", help: "A path like /contact or a full https:// address." },
      { name: "is_active", label: "Active", type: "bool", help: "Only the most recently created active promotion is shown." },
      { name: "starts_at", label: "Starts", type: "datetime" },
      { name: "ends_at", label: "Ends", type: "datetime" },
      { name: "display_frequency", label: "Show how often", type: "select", options: ["every_visit", "once_per_session", "once_per_day", "once_per_week", "once"] },
      { name: "show_on_mobile", label: "Show on mobile", type: "bool" },
    ],
    columns: [{ label: "Title", path: "title" }, { label: "Active", path: "is_active", kind: "bool" }, { label: "Starts", path: "starts_at", kind: "date" }, { label: "Ends", path: "ends_at", kind: "date" }],
  },
  discounts: {
    slug: "discounts", table: "discounts", title: "Promo codes", singular: "promo code",
    select: "*", orderBy: "created_at", ascending: false, canCreate: true, canDelete: true,
    fields: [
      { name: "label", label: "Label shown on the quote", type: "text", required: true },
      { name: "code", label: "Code customers enter", type: "text", required: true },
      { name: "kind", label: "Type", type: "select", options: ["flat", "percent"], required: true },
      { name: "amount", label: "Amount (dollars or percent)", type: "number", required: true, step: 0.01 },
      { name: "is_active", label: "Active", type: "bool" },
      { name: "starts_at", label: "Starts", type: "datetime" },
      { name: "ends_at", label: "Ends", type: "datetime" },
    ],
    columns: [{ label: "Code", path: "code" }, { label: "Label", path: "label" }, { label: "Type", path: "kind" }, { label: "Amount", path: "amount" }, { label: "Active", path: "is_active", kind: "bool" }],
  },
  pricing: {
    slug: "pricing", table: "pricing_configs", title: "Pricing configurations", singular: "pricing configuration",
    select: "*, vehicles(name)", orderBy: "created_at", ascending: false, canCreate: true, canDelete: true,
    filterField: "status",
    fields: [
      { name: "vehicle_id", label: "Vehicle", type: "ref", ref: "vehicles", required: true },
      { name: "status", label: "Status", type: "select", options: ["draft", "active", "archived"], required: true, help: "Only an active configuration is used for customer quotes. Activating one archives the vehicle's current active configuration." },
      { name: "label", label: "Label", type: "text" },
      { name: "notes", label: "Internal notes", type: "textarea" },
      { name: "currency", label: "Currency", type: "text", required: true },
      { name: "per_mile", label: "Per mile ($)", type: "number", required: true, step: 0.01 },
      { name: "hourly_rate", label: "Hourly rate ($)", type: "number", step: 0.01, help: "Leave blank if hourly booking is not offered." },
      { name: "min_hours", label: "Minimum hours (hourly)", type: "number", required: true, step: 0.5 },
      { name: "minimum_fare", label: "Minimum fare ($)", type: "number", required: true, step: 0.01 },
      { name: "base_fare", label: "Base fare ($)", type: "number", step: 0.01 },
      { name: "hourly_included_miles", label: "Included miles (hourly)", type: "number", required: true, step: 0.1 },
      { name: "hourly_included_scope", label: "Included miles apply", type: "select", options: ["booking", "per_hour"], required: true },
      { name: "hourly_extra_mile_rate", label: "Extra mile rate ($, hourly)", type: "number", required: true, step: 0.01 },
      { name: "long_trip_threshold_miles", label: "Long trip after (miles)", type: "number", step: 0.1 },
      { name: "long_trip_per_mile", label: "Long trip per mile ($)", type: "number", step: 0.01 },
    ],
    columns: [
      { label: "Vehicle", path: "vehicles.name" }, { label: "Status", path: "status", kind: "status" }, { label: "Label", path: "label" },
      { label: "Per mile", path: "per_mile" }, { label: "Hourly", path: "hourly_rate" }, { label: "Minimum", path: "minimum_fare" },
    ],
    refLabel: (r) => `${nested(r, "vehicles")} (${String(r.status ?? "")}${r.label ? ", " + String(r.label) : ""})`,
  },
  surcharges: {
    slug: "surcharges", table: "pricing_surcharges", title: "Surcharges", singular: "surcharge",
    select: "*, pricing_configs(vehicles(name))", orderBy: "created_at", ascending: false, canCreate: true, canDelete: true,
    fields: [
      { name: "pricing_config_id", label: "Pricing configuration", type: "ref", ref: "pricing", required: true },
      { name: "label", label: "Label shown on the quote", type: "text", required: true },
      { name: "kind", label: "Type", type: "select", options: ["flat", "percent"], required: true },
      { name: "amount", label: "Amount (dollars or percent)", type: "number", required: true, step: 0.01 },
      { name: "is_active", label: "Active", type: "bool" },
    ],
    columns: [{ label: "Label", path: "label" }, { label: "Type", path: "kind" }, { label: "Amount", path: "amount" }, { label: "Active", path: "is_active", kind: "bool" }],
  },
  "follow-ups": {
    slug: "follow-ups", table: "follow_ups", title: "Follow-ups", singular: "follow-up",
    select: "*, customers(name)", orderBy: "due_at", ascending: true, canCreate: true, canDelete: true,
    rowAction: { label: "Mark complete", field: "completed_at" },
    fields: [
      { name: "title", label: "Reminder", type: "text", required: true },
      { name: "customer_id", label: "Customer", type: "ref", ref: "customers" },
      { name: "due_at", label: "Due", type: "datetime", required: true },
      { name: "notes", label: "Notes", type: "textarea" },
      { name: "completed_at", label: "Completed at", type: "datetime", help: "Leave blank while still open." },
    ],
    columns: [{ label: "Reminder", path: "title" }, { label: "Customer", path: "customers.name" }, { label: "Due", path: "due_at", kind: "date" }, { label: "Completed", path: "completed_at", kind: "date" }],
  },
  customers: {
    slug: "customers", table: "customers", title: "Customers", singular: "customer",
    select: "*", orderBy: "created_at", ascending: false, canCreate: true, canDelete: false,
    filterField: "status", searchPaths: ["name", "email", "phone"], detailHref: "/admin/customers/",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "email", label: "Email", type: "text" },
      { name: "phone", label: "Phone", type: "text" },
      { name: "status", label: "Status", type: "select", options: ["active", "vip", "inactive", "blocked"], required: true },
      { name: "notes", label: "Notes", type: "textarea" },
    ],
    columns: [{ label: "Name", path: "name" }, { label: "Email", path: "email" }, { label: "Phone", path: "phone" }, { label: "Status", path: "status", kind: "status" }, { label: "Created", path: "created_at", kind: "date" }],
    refLabel: (r) => `${String(r.name ?? "")} ${r.email ? "(" + String(r.email) + ")" : ""}`.trim(),
  },
  leads: {
    slug: "leads", table: "leads", title: "Leads and inquiries", singular: "lead",
    select: "*", orderBy: "created_at", ascending: false, canCreate: false, canDelete: false,
    filterField: "status", searchPaths: ["name", "email", "phone", "subject", "message"], detailHref: "/admin/leads/",
    fields: [{ name: "status", label: "Status", type: "select", options: LEAD_STATUSES, required: true }],
    columns: [{ label: "Name", path: "name" }, { label: "Subject", path: "subject" }, { label: "Status", path: "status", kind: "status" }, { label: "Received", path: "created_at", kind: "date" }],
  },
  bookings: {
    slug: "bookings", table: "bookings", title: "Bookings", singular: "booking",
    select: "*, customers(name,email,phone), vehicles(name)", orderBy: "pickup_at", ascending: false, canCreate: false, canDelete: false,
    filterField: "status", searchPaths: ["reference", "pickup_address", "dropoff_address", "customers.name", "customers.email", "customers.phone"], detailHref: "/admin/bookings/",
    fields: [
      { name: "status", label: "Status", type: "select", options: BOOKING_STATUSES, required: true },
      { name: "vehicle_id", label: "Vehicle", type: "ref", ref: "vehicles" },
      { name: "pickup_address", label: "Pickup", type: "text", required: true },
      { name: "dropoff_address", label: "Destination", type: "text" },
      { name: "pickup_at", label: "Pickup time", type: "datetime", required: true },
      { name: "passengers", label: "Passengers", type: "number", required: true },
      { name: "estimated_fare_cents", label: "Fare ($)", type: "money", help: "Changing this does not alter the stored price snapshot." },
      { name: "notes", label: "Customer notes", type: "textarea" },
      { name: "admin_notes", label: "Internal notes", type: "textarea" },
    ],
    columns: [
      { label: "Reference", path: "reference" }, { label: "Customer", path: "customers.name" }, { label: "Pickup", path: "pickup_at", kind: "date" },
      { label: "Vehicle", path: "vehicles.name" }, { label: "Fare", path: "estimated_fare_cents", kind: "money" }, { label: "Status", path: "status", kind: "status" },
    ],
  },
  "booking-settings": {
    slug: "booking-settings", table: "booking_settings", title: "Booking settings", singular: "setting",
    select: "*", orderBy: "updated_at", ascending: false, canCreate: false, canDelete: false,
    fields: [
      { name: "meet_greet_enabled", label: "Airport Meet & Greet can be requested", type: "bool" },
      { name: "meet_greet_charge_cents", label: "Meet & Greet charge ($)", type: "money", help: "Leave blank until a price is approved. Customers then see \"charge to be confirmed\"." },
      { name: "meet_greet_charge_approved", label: "Meet & Greet charge is approved", type: "bool", help: "The charge is only added to totals when this is on." },
      { name: "waiting_included_minutes", label: "Included waiting time (minutes)", type: "number", required: true },
      { name: "waiting_increment_minutes", label: "Waiting charge increment (minutes)", type: "number", required: true },
      { name: "waiting_rate_cents", label: "Waiting rate per increment ($)", type: "money", help: "Leave blank until a rate is approved." },
      { name: "waiting_rate_approved", label: "Waiting rate is approved", type: "bool" },
      { name: "child_seat_one_way_cents", label: "Child car seat price, one way ($ per seat)", type: "money", help: "Initial value from the client: $10. Applied per seat." },
      { name: "child_seat_round_trip_cents", label: "Child car seat price, round trip ($ per seat)", type: "money", help: "Initial value from the client: $15. Charged once per seat for the whole round trip, not per leg." },
      { name: "child_seat_max", label: "Maximum child seats per booking", type: "number" },
      { name: "payment_mode", label: "Online payment", type: "select", options: ["disabled", "full", "deposit_fixed", "deposit_percent"], help: "disabled = booking requests only. Needs Stripe keys on the server to take effect." },
      { name: "deposit_fixed_cents", label: "Deposit: fixed amount ($)", type: "money", help: "Used when Online payment is deposit_fixed. Leave blank until approved." },
      { name: "deposit_percent", label: "Deposit: percent of the total", type: "number", step: 0.01, help: "Used when Online payment is deposit_percent (1 to 100)." },
      { name: "payment_terms", label: "Payment terms shown to customers", type: "textarea", help: "Only wording the business has approved (refunds, cancellations). Leave blank to show none." },
    ],
    columns: [
      { label: "Meet & Greet", path: "meet_greet_enabled", kind: "bool" }, { label: "M&G charge", path: "meet_greet_charge_cents", kind: "money" },
      { label: "Included wait (min)", path: "waiting_included_minutes" }, { label: "Waiting rate", path: "waiting_rate_cents", kind: "money" },
      { label: "Seat (1-way)", path: "child_seat_one_way_cents", kind: "money" }, { label: "Seat (round trip)", path: "child_seat_round_trip_cents", kind: "money" }, { label: "Payment", path: "payment_mode" },
    ],
  },
  "round-trip": {
    slug: "round-trip", table: "round_trip_rules", title: "Round-trip discount rules", singular: "round-trip rule",
    select: "*, vehicle_categories(name)", orderBy: "created_at", ascending: false, canCreate: true, canDelete: true,
    fields: [
      { name: "label", label: "Label shown on the quote", type: "text", required: true },
      { name: "kind", label: "Type", type: "select", options: ["percent", "flat"], required: true },
      { name: "amount", label: "Amount (percent, or dollars off the whole round trip)", type: "number", required: true, step: 0.01 },
      { name: "category_id", label: "Vehicle category (blank = all)", type: "ref", ref: "categories" },
      { name: "is_active", label: "Active", type: "bool", help: "Nothing is discounted until a rule is created and activated. The discount applies to fare components (not tolls or extras)." },
      { name: "starts_at", label: "Starts", type: "datetime" },
      { name: "ends_at", label: "Ends", type: "datetime" },
      { name: "notes", label: "Internal notes", type: "textarea" },
    ],
    columns: [{ label: "Label", path: "label" }, { label: "Type", path: "kind" }, { label: "Amount", path: "amount" }, { label: "Category", path: "vehicle_categories.name" }, { label: "Active", path: "is_active", kind: "bool" }],
  },
  quotes: {
    slug: "quotes", table: "quote_requests", title: "Quote requests", singular: "quote request",
    select: "*, vehicles(name)", orderBy: "created_at", ascending: false, canCreate: false, canDelete: false,
    filterField: "status", searchPaths: ["name", "email", "phone"], detailHref: "/admin/quotes/",
    fields: [
      { name: "status", label: "Status", type: "select", options: QUOTE_STATUSES, required: true },
      { name: "discount_decision", label: "Discount decision", type: "select", options: ["pending", "approved", "rejected"], required: true },
      { name: "revised_price_cents", label: "Revised price ($)", type: "money" },
      { name: "admin_notes", label: "Internal notes", type: "textarea" },
    ],
    columns: [
      { label: "Customer", path: "name" }, { label: "Vehicle", path: "vehicles.name" }, { label: "Original", path: "original_quote_cents", kind: "money" },
      { label: "Wants", path: "desired_budget_cents", kind: "money" }, { label: "Status", path: "status", kind: "status" }, { label: "Received", path: "created_at", kind: "date" },
    ],
  },
};

export function toClient(r: Resource): ClientResource {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { refLabel, select, orderBy, table, ...rest } = r;
  return rest;
}
