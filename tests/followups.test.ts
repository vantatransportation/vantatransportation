import { test } from "node:test";
import assert from "node:assert/strict";
import { followUpState } from "../src/lib/admin/followups.ts";

const now = Date.parse("2026-06-15T12:00:00Z");

test("follow-up state: completed wins, then overdue vs open by due time", () => {
  assert.equal(followUpState({ due_at: "2026-06-01T00:00:00Z", completed_at: "2026-06-02T00:00:00Z" }, now), "done");
  assert.equal(followUpState({ due_at: "2026-06-14T12:00:00Z", completed_at: null }, now), "overdue");
  assert.equal(followUpState({ due_at: "2026-06-16T12:00:00Z", completed_at: null }, now), "open");
  assert.equal(followUpState({ due_at: "2026-06-15T12:00:00Z", completed_at: null }, now), "open"); // due exactly now: not yet overdue
});
