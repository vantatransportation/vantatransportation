# Social media links in the footer and on the Contact page

## Files changed / added
* `src/lib/social-links.ts` (new): single source of truth for the five official URLs.
* `src/components/SocialLinks.tsx` (new): icon buttons (inline SVG brand glyphs, no new dependency; no icon library was installed).
* `src/components/SiteFooter.tsx`: renders `<SocialLinks />` under the brand tagline; all existing footer content untouched.
* `src/app/(site)/contact/page.tsx`: "Follow Us" block in the Details column, under the contact details/map and above the FAQ link.
* `src/app/globals.css`: `.social`, `.social__link`, `.contact-social` rules using the existing theme tokens (dark and light).
* `tests/social-links.test.ts` (new): exact URLs, footer + Contact usage, `target="_blank"`, `rel="noopener noreferrer"`, aria-labels.

## Behaviour
Each icon is a 44x44 circular button with `aria-label="Follow Vanta Transportation on <Network>"` and a hover `title`,
opens in a new tab with `rel="noopener noreferrer"`, and has hover and keyboard-focus states. Colours come from the theme
tokens, so contrast follows the dark/light themes. No database, admin, booking, payment or other changes.
