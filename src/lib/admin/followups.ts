export type FollowUpState = "done" | "overdue" | "open";

/**
 * Pure follow-up status. The current time is passed in rather than read here, so the result depends only on
 * its inputs. A completed follow-up is "done"; otherwise it is "overdue" once its due time has passed.
 */
export function followUpState(f: { due_at: string; completed_at: string | null }, nowMs: number): FollowUpState {
  if (f.completed_at) return "done";
  return new Date(f.due_at).getTime() < nowMs ? "overdue" : "open";
}
