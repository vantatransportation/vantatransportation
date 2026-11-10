export interface CalculatorPrefill { pickup?: string; dropoff?: string; date?: string; time?: string }
export const OPEN_EVENT = "vanta:open-calculator";

/** Opens the fare calculator from anywhere (buttons, the homepage trip form). */
export function openCalculator(prefill?: CalculatorPrefill) {
  window.dispatchEvent(new CustomEvent<CalculatorPrefill>(OPEN_EVENT, { detail: prefill ?? {} }));
}
