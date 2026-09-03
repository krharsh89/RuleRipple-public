import { safeWorkspace, WORKSPACE_LIMITS, type WorkspaceData } from "./domain.ts";
import { unconfiguredWorkspace } from "./presets.ts";

export interface AppState {
  data: WorkspaceData;
  undo: Record<string, WorkspaceData>;
}

// External executions live inside the existing segmented payload, so the
// manifest layout remains schema v5. Keeping the manifest version stable lets
// the release work with the already-deployed ownership rules.
export const CLOUD_SCHEMA_VERSION = 5;

export interface CloudWorkspaceDocument {
  schemaVersion: number;
  ownerId: string;
  ownerEmail: string | null;
  state: AppState;
  revision: number;
}

export interface CloudWorkspaceManifest {
  schemaVersion: number;
  ownerId: string;
  ownerEmail: string | null;
  revision: number;
  segmentCount: number;
  storageLayout: "segmented-v1";
}

export const CLOUD_SEGMENT_MAX_BYTES = 450_000;

export function safeCloudWorkspaceManifest(value: unknown): Pick<CloudWorkspaceManifest, "revision" | "segmentCount"> | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CloudWorkspaceManifest>;
  if (Number(candidate.schemaVersion) !== CLOUD_SCHEMA_VERSION || candidate.storageLayout !== "segmented-v1" || !Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 1 || !Number.isSafeInteger(candidate.segmentCount) || Number(candidate.segmentCount) < 1 || Number(candidate.segmentCount) > 64) return null;
  return { revision: Number(candidate.revision), segmentCount: Number(candidate.segmentCount) };
}

export function segmentAppState(value: AppState, maxBytes = CLOUD_SEGMENT_MAX_BYTES): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_000) throw new Error("Segment size is invalid.");
  const serialized = JSON.stringify(firestoreAppState(value));
  const encoder = new TextEncoder();
  const segments: string[] = [];
  let current = "", currentBytes = 0;
  for (const character of serialized) {
    const bytes = encoder.encode(character).length;
    if (current && currentBytes + bytes > maxBytes) { segments.push(current); current = ""; currentBytes = 0; }
    current += character; currentBytes += bytes;
  }
  if (current || !segments.length) segments.push(current);
  if (segments.length > 64) throw new Error("Workspace exceeds the cloud storage limit. Export the audit file before starting a new workspace.");
  return segments;
}

export function restoreSegmentedAppState(segments: string[]): AppState | null {
  if (!segments.length || segments.length > 64 || segments.some((item) => typeof item !== "string" || new TextEncoder().encode(item).length > CLOUD_SEGMENT_MAX_BYTES)) return null;
  try { return safeAppState(JSON.parse(segments.join(""))); } catch { return null; }
}

export function safeCloudWorkspaceDocument(value: unknown): Pick<CloudWorkspaceDocument, "state" | "revision"> | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CloudWorkspaceDocument>;
  const state = safeAppState(candidate.state);
  if (!state || ![4, CLOUD_SCHEMA_VERSION].includes(Number(candidate.schemaVersion)) || !Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 1) return null;
  return { state, revision: Number(candidate.revision) };
}

export function freshAppState(): AppState {
  return { data: unconfiguredWorkspace(), undo: {} };
}

export function firestoreAppState(value: AppState): AppState {
  return JSON.parse(JSON.stringify(value)) as AppState;
}

export function cloudWriteDecision(remoteSerialized: string, expectedSerialized: string, nextSerialized: string): "noop" | "write" | "conflict" {
  if (remoteSerialized === nextSerialized) return "noop";
  return remoteSerialized === expectedSerialized ? "write" : "conflict";
}

export function safeAppState(value: unknown): AppState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { data?: unknown; undo?: unknown };
  const data = safeWorkspace(candidate.data);
  if (!data) return null;
  const entries = candidate.undo && typeof candidate.undo === "object"
    ? Object.entries(candidate.undo as Record<string, unknown>)
    : [];
  const undo = Object.fromEntries(entries.flatMap(([id, snapshot]) => {
    const safe = safeWorkspace(snapshot);
    return safe ? [[id, safe]] : [];
  }).slice(-WORKSPACE_LIMITS.undoSnapshots));
  return { data, undo };
}

export function safeLegacyAppState(value: unknown): AppState | null {
  const direct = safeAppState(value);
  if (direct) return direct;
  const data = safeWorkspace(value);
  return data ? { data, undo: {} } : null;
}
