export interface Category { id: string; name: string; slug: string; description: string; capacityLabel: string; image: string }
export interface Vehicle {
  id: string; name: string; categoryName: string; categorySlug: string;
  /** The vehicle's first (lowest-order) service tier, or "" when it has none. Use `tierNames` to show every tier. */
  tierName: string;
  /** Every active service tier the vehicle is offered in, in tier order. */
  tierNames?: string[];
  similarModels: string; description: string; passengers: number; luggage: number | null;
  /** Real photo URL, or null (a branded placeholder is shown). */
  image: string | null; capacityLabel: string; isAvailable: boolean;
}
export interface Standard { id: string; title: string; description: string }
export interface Faq { id: string; question: string; answer: string }
export interface Service { title: string; description: string }

export interface Promotion {
  id: string; title: string; description: string; imageUrl: string; ctaText: string; ctaUrl: string;
  frequency: "every_visit" | "once_per_session" | "once_per_day" | "once_per_week" | "once";
  showOnMobile: boolean; updatedAt: string;
}

export interface SiteData {
  source: "supabase" | "defaults";
  categories: Category[];
  vehicles: Vehicle[];
  standards: Standard[];
  faqs: Faq[];
  content: Record<string, unknown>;
  promotion: Promotion | null;
}
