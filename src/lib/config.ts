/** Time zone in which customers' pickup dates and times are interpreted. */
export const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || "America/New_York";

/** Initial business notification recipient (not a secret). Override with BUSINESS_NOTIFICATION_EMAIL. */
export const DEFAULT_BUSINESS_EMAIL = "vantatransportation.1@gmail.com";
