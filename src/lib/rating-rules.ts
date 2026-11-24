/** Pure rules shared by the rating and performance-points routes and their tests. */
export const FEEDBACK_MAX = 1000;

export function parseRating(stars: unknown, feedback: unknown): { ok: true; stars: number; feedback: string | null } | { ok: false; error: string } {
  const n = typeof stars === "number" ? stars : typeof stars === "string" && /^\d$/.test(stars) ? Number(stars) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 5) return { ok: false, error: "Choose a rating from 1 to 5 stars." };
  if (feedback != null && typeof feedback !== "string") return { ok: false, error: "Feedback must be text." };
  const text = typeof feedback === "string" ? feedback.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim() : "";
  if (text.length > FEEDBACK_MAX) return { ok: false, error: `Feedback can be at most ${FEEDBACK_MAX} characters.` };
  return { ok: true, stars: n, feedback: text || null };
}

/** A new score from either a signed adjustment or an absolute value. Always lands inside 0-100, or the request is refused. */
export function resolvePoints(current: number, input: { adjustment?: unknown; newPoints?: unknown }): { ok: true; previous: number; next: number; adjustment: number } | { ok: false; error: string } {
  if (!Number.isInteger(current) || current < 0 || current > 100) return { ok: false, error: "The stored score is invalid." };
  const hasAdj = input.adjustment !== undefined && input.adjustment !== null && input.adjustment !== "";
  const hasNew = input.newPoints !== undefined && input.newPoints !== null && input.newPoints !== "";
  if (hasAdj === hasNew) return { ok: false, error: "Provide either an adjustment or a new score." };
  const v = Number(hasAdj ? input.adjustment : input.newPoints);
  if (!Number.isInteger(v)) return { ok: false, error: "Points must be a whole number." };
  const next = hasAdj ? current + v : v;
  if (next < 0 || next > 100) return { ok: false, error: `That would make the score ${next}. Scores must stay between 0 and 100.` };
  if (next === current) return { ok: false, error: "That does not change the score." };
  return { ok: true, previous: current, next, adjustment: next - current };
}

export const average = (stars: number[]): { avg: number | null; count: number } =>
  stars.length ? { avg: Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 10) / 10, count: stars.length } : { avg: null, count: 0 };
