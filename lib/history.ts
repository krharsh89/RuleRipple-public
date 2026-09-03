import { nextId, type ActivityEvent, type WorkspaceData } from "./domain.ts";

export type UndoSnapshots = Record<string, WorkspaceData>;

export function latestUndoableEventId(activity: ActivityEvent[], undo: UndoSnapshots) {
  return activity.find((event) => event.undoable && Boolean(undo[event.id]))?.id ?? null;
}

export function undoPreservesCurrentAudit(event: ActivityEvent) {
  return event.changeKind !== "workspace_replace";
}

export function undoActivityBase(event: ActivityEvent, current: ActivityEvent[], restored: ActivityEvent[]) {
  return event.changeKind === "workspace_replace" ? restored : current;
}

export function nextActivityId(activity: ActivityEvent[], undo: UndoSnapshots, additional: ActivityEvent[] = []) {
  return nextId("A", [...activity, ...additional, ...Object.keys(undo).map((id) => ({ id }))]);
}
