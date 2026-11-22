/**
 * Official Vanta Transportation social profiles. Single source of truth: the footer and the Contact page both render
 * from this list, so a URL is only ever edited here.
 */
export type SocialId = "x" | "instagram" | "facebook" | "threads" | "tiktok";

export type SocialLink = { id: SocialId; name: string; href: string };

export const SOCIAL_LINKS: readonly SocialLink[] = [
  { id: "x", name: "X (Twitter)", href: "https://x.com/vantatransport" },
  { id: "instagram", name: "Instagram", href: "https://www.instagram.com/vantatransportation" },
  { id: "facebook", name: "Facebook", href: "https://www.facebook.com/vantatransportation/" },
  { id: "threads", name: "Threads", href: "https://www.threads.com/@vantatransportation" },
  { id: "tiktok", name: "TikTok", href: "https://www.tiktok.com/@vantatransportation" },
];
