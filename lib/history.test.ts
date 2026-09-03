import assert from "node:assert/strict";
import test from "node:test";

import { type ActivityEvent, type WorkspaceData } from "./domain.ts";
import { defaultWorkspace } from "./preset-fixtures.test.ts";
import { latestUndoableEventId, nextActivityId, undoActivityBase, undoPreservesCurrentAudit } from "./history.ts";

const event = (id: string): ActivityEvent => ({
  id,
  actor: "human",
  action: id,
  detail: id,
  createdAt: "2026-08-28T00:00:00.000Z",
  undoable: true,
});

const snapshot = (): WorkspaceData => structuredClone(defaultWorkspace);

test("only the newest reversible activity entry is offered for undo", () => {
  const activity = [event("A-05"), event("A-04")];
  const undo = { "A-04": snapshot(), "A-05": snapshot() };
  assert.equal(latestUndoableEventId(activity, undo), "A-05");
});

test("the previous entry becomes available after the newest undo is consumed", () => {
  const activity = [event("A-05"), event("A-04")];
  const undo = { "A-04": snapshot() };
  assert.equal(latestUndoableEventId(activity, undo), "A-04");
});

test("independent simulation replacement restores its original audit history", () => {
  const replacement = { ...event("A-06"), changeKind: "workspace_replace" as const };
  const current = [event("A-06"), event("A-02")], restored = [event("A-20"), event("A-19")];
  assert.equal(undoPreservesCurrentAudit(replacement), false);
  assert.deepEqual(undoActivityBase(replacement, current, restored), restored);
  assert.equal(undoPreservesCurrentAudit(event("A-05")), true);
  assert.deepEqual(undoActivityBase(event("A-05"), current, restored), current);
});

test("activity IDs remain unique across simulation workspaces and retained undo snapshots", () => {
  const current = [event("A-03")], restored = [event("A-20")];
  assert.equal(nextActivityId(current, { "A-12": snapshot() }, restored), "A-21");
});
