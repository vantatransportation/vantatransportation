/**
 * Loads Stripe.js (https://js.stripe.com/v3) in the browser, once. Card numbers are typed into Stripe's own iframe and go straight to Stripe:
 * they never touch this site's code, server, database or logs. The publishable key is public by design.
 */
export interface StripeElement { mount(el: HTMLElement): void; unmount(): void; destroy(): void; on(event: string, cb: (e: { complete?: boolean }) => void): void }
export interface StripeElements { create(type: "payment", opts?: Record<string, unknown>): StripeElement; submit(): Promise<{ error?: { message?: string } }> }
export interface StripeJs {
  elements(opts: Record<string, unknown>): StripeElements;
  confirmSetup(o: Record<string, unknown>): Promise<{ error?: { message?: string }; setupIntent?: { status: string } }>;
  handleNextAction(o: { clientSecret: string }): Promise<{ error?: { message?: string }; paymentIntent?: { status: string } }>;
}
declare global { interface Window { Stripe?: (key: string) => StripeJs } }

let scriptPromise: Promise<void> | null = null;
export function loadStripeJs(publishableKey: string): Promise<StripeJs> {
  if (!publishableKey) return Promise.reject(new Error("Card payment is not available right now."));
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      if (window.Stripe) return resolve();
      const s = document.createElement("script");
      s.src = "https://js.stripe.com/v3"; s.async = true;
      s.onload = () => (window.Stripe ? resolve() : reject(new Error("Stripe did not load")));
      s.onerror = () => { scriptPromise = null; reject(new Error("The secure card form could not be loaded. Please check your connection and try again.")); };
      document.head.appendChild(s);
    });
  }
  return scriptPromise.then(() => window.Stripe!(publishableKey));
}
