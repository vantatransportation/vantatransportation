/**
 * Parsing of the redirect Supabase Auth sends the browser to after a driver clicks the link in an invitation
 * (or password-setup) email. Pure functions, so they can be tested without a browser.
 *
 * Supabase's default "implicit" flow redirects to `<redirectTo>#access_token=…&refresh_token=…&type=invite`.
 * A failed or expired link redirects to `<redirectTo>#error=access_denied&error_code=otp_expired&error_description=…`
 * (some setups put the same parameters in the query string instead). Neither is ever visible to the server.
 */

export const SET_PASSWORD_PATH = "/driver/set-password";

export type InviteLink =
  | { kind: "session"; accessToken: string; linkType: string | null }
  | { kind: "error"; code: string; message: string }
  | { kind: "none" };

const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const FORWARD_TYPES = new Set(["invite", "recovery", "signup", "magiclink", "email_change"]);

function params(hash: string, search: string): URLSearchParams {
  const merged = new URLSearchParams(search.replace(/^\?/, ""));
  // Hash values win: that is where Supabase's implicit flow puts both tokens and errors.
  for (const [k, v] of new URLSearchParams(hash.replace(/^#/, ""))) merged.set(k, v);
  return merged;
}

/** A short, human explanation for a Supabase auth error redirect. Never echoes raw provider text as the only message. */
export function describeLinkError(code: string, description: string): string {
  const c = code.toLowerCase();
  if (c === "otp_expired" || /expired|invalid/i.test(description)) {
    return "This invitation link has expired or has already been used. Invitation links only work once, and some email apps open links automatically before you do.";
  }
  if (c === "access_denied") return "This invitation link could not be accepted.";
  return description ? `This invitation link could not be used (${description.slice(0, 160)}).` : "This invitation link is not valid.";
}

export function parseInviteLink(hash: string, search = ""): InviteLink {
  const p = params(hash, search);
  const token = p.get("access_token");
  if (token) {
    if (token.length > 4000 || !JWT_SHAPE.test(token)) {
      return { kind: "error", code: "malformed", message: "This invitation link looks incomplete (it may have been cut short by your email app). Ask Vanta to send a new one, then open it in your phone or computer's browser." };
    }
    return { kind: "session", accessToken: token, linkType: p.get("type") };
  }
  const code = p.get("error_code") ?? p.get("error");
  if (code) return { kind: "error", code, message: describeLinkError(code, p.get("error_description") ?? "") };
  return { kind: "none" };
}

/**
 * If a Supabase auth redirect lands on some other page (for example the Site URL when the redirect URL is not on the
 * allow-list), returns the set-password URL to forward it to, keeping the hash and query so nothing is lost.
 */
export function forwardTarget(loc: { pathname: string; hash: string; search: string }): string | null {
  if (loc.pathname === SET_PASSWORD_PATH) return null;
  const link = parseInviteLink(loc.hash, loc.search);
  if (link.kind === "session") return link.linkType && FORWARD_TYPES.has(link.linkType) ? `${SET_PASSWORD_PATH}${loc.search}${loc.hash}` : null;
  if (link.kind === "error") {
    const p = params(loc.hash, loc.search);
    // Only auth redirects carry error_code together with error_description; leave any other ?error= alone.
    return p.get("error_code") && p.get("error_description") !== null ? `${SET_PASSWORD_PATH}${loc.search}${loc.hash}` : null;
  }
  return null;
}
