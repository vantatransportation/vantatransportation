import type { SupabaseClient } from "@supabase/supabase-js";
import { phoneDigits } from "./validation";

/**
 * Finds an existing customer by email, then by phone (last 10 digits), otherwise creates one.
 * Avoids duplicate customer records for returning customers.
 */
export async function findOrCreateCustomer(
  db: SupabaseClient,
  input: { name: string; email?: string | null; phone?: string | null },
): Promise<string> {
  const email = input.email?.trim().toLowerCase() || null;
  const phone = input.phone?.trim() || null;

  if (email) {
    const r = await db.from("customers").select("id").eq("email_normalized", email).maybeSingle();
    if (r.data) return r.data.id as string;
  }
  if (phone) {
    const digits = phoneDigits(phone);
    if (digits.length >= 10) {
      const r = await db.from("customers").select("id").eq("phone_digits", digits).order("created_at").limit(1).maybeSingle();
      if (r.data) return r.data.id as string;
    }
  }
  const created = await db.from("customers").insert({ name: input.name, email, phone }).select("id").single();
  if (created.error) {
    // Lost a race on the unique email index: fetch the winner.
    if (created.error.code === "23505" && email) {
      const r = await db.from("customers").select("id").eq("email_normalized", email).maybeSingle();
      if (r.data) return r.data.id as string;
    }
    throw created.error;
  }
  return created.data.id as string;
}
