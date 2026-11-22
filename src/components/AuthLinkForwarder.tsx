"use client";

import { useEffect } from "react";
import { forwardTarget } from "@/lib/driver/invite-link";

/**
 * Safety net for Supabase email links. If a driver's invitation link lands anywhere other than /driver/set-password
 * (for example on the home page, because the redirect URL is missing from Supabase's allow-list and Supabase fell back
 * to the Site URL), pass the token or error on to the set-password page instead of dropping it. Renders nothing.
 */
export default function AuthLinkForwarder() {
  useEffect(() => {
    const to = forwardTarget(window.location);
    if (to) window.location.replace(to);
  }, []);
  return null;
}
