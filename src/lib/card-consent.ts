/**
 * The exact wording a customer agrees to. Pure (no server-only imports): the browser shows it, the server stores it with the booking
 * (bookings.card_consent_text) so there is a record of what was agreed, and the tests check it.
 *
 * Two SEPARATE consents, because they are two separate decisions:
 *  1. at booking: save the card now, charge nothing, hold nothing;
 *  2. after admin approval: confirm the booking and charge the saved card the displayed total.
 */
export const CARD_SAVE_CONSENT_TEXT =
  "I authorize Vanta Transportation to securely save this card with Stripe for this booking only. Nothing is charged and no funds are held now. " +
  "If Vanta approves my booking, I will be asked to confirm it before the saved card is charged the total shown.";

export const CARD_CHARGE_CONSENT_VERSION = "v1";
export const cardChargeConsentText = (amountLabel: string) =>
  `I confirm this booking and authorize Vanta Transportation to charge my saved card ${amountLabel} now.`;
