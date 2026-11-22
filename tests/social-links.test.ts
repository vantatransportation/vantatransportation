import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SOCIAL_LINKS } from "../src/lib/social-links.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("social links: exactly the five official URLs", () => {
  assert.deepEqual(
    SOCIAL_LINKS.map((s) => s.href),
    [
      "https://x.com/vantatransport",
      "https://www.instagram.com/vantatransportation",
      "https://www.facebook.com/vantatransportation/",
      "https://www.threads.com/@vantatransportation",
      "https://www.tiktok.com/@vantatransportation",
    ],
  );
});

test("social links: rendered in the global footer and on the Contact page, opening safely in a new tab", () => {
  assert.match(read("../src/components/SiteFooter.tsx"), /<SocialLinks/);
  assert.match(read("../src/app/(site)/contact/page.tsx"), /<SocialLinks/);
  const c = read("../src/components/SocialLinks.tsx");
  assert.match(c, /target="_blank"/);
  assert.match(c, /rel="noopener noreferrer"/);
  assert.match(c, /aria-label=\{`Follow Vanta Transportation on \$\{s\.name\}`\}/);
});
