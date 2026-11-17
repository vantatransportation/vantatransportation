import "server-only";
import { revalidatePath } from "next/cache";

/** Tables whose rows are rendered on the public website. A successful write to any of them must refresh the site. */
export const PUBLIC_TABLES = new Set(["vehicles", "vehicle_categories", "vehicle_tiers", "vehicle_standards", "faqs", "promotions", "site_content"]);

/**
 * Drops the cached (ISR) copy of every public page so the next visitor gets fresh database values instead of waiting
 * for the 60 s timer. The "layout" scope on "/" covers the home page, /rides, /about, /quote, /book and the shared layout.
 * Never throws: the database write has already succeeded, so a cache problem must not turn it into a failed save.
 */
export function revalidateSite(): boolean {
  try {
    revalidatePath("/", "layout");
    return true;
  } catch (e) {
    console.error("[admin] revalidatePath failed", e);
    return false;
  }
}
