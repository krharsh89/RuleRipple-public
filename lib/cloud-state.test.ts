import assert from "node:assert/strict";
import test from "node:test";
import { type WorkspaceData } from "./domain.ts";
import { defaultWorkspace } from "./preset-fixtures.test.ts";
import { CLOUD_SCHEMA_VERSION, cloudWriteDecision, firestoreAppState, freshAppState, restoreSegmentedAppState, safeAppState, safeCloudWorkspaceDocument, safeCloudWorkspaceManifest, safeLegacyAppState, segmentAppState } from "./cloud-state.ts";
import { policyTemplateWorkspace, simulationPresets, workspaceNeedsConfiguration } from "./presets.ts";

test("accepts a valid cloud workspace and rejects malformed state", () => {
  const state = freshAppState();
  assert.equal(safeAppState(state)?.data.presetId, "unconfigured");
  assert.equal(workspaceNeedsConfiguration(state.data), true);
  assert.equal(state.data.policy.resources[0].capacity, 0);
  assert.equal(state.data.policy.resources[0].reserve, 0);
  assert.equal(state.data.rules.length, 0);
  assert.equal(state.data.cases.length, 0);
  assert.equal(state.data.ledger.length, 0);
  assert.equal(state.data.versions.length, 0);
  assert.equal(state.data.activity.length, 0);
  assert.equal(safeAppState({ data: { policy: null }, undo: {} }), null);
});

test("ships only clean, unconfigured policy templates", () => {
  for (const preset of simulationPresets) {
    const schema = policyTemplateWorkspace(preset);
    assert.equal(workspaceNeedsConfiguration(schema), true);
    assert.equal(schema.rules.length, 0);
    assert.equal(schema.cases.length, 0);
    assert.equal(schema.versions.length, 0);
    assert.equal(schema.activity.length, 0);
    assert.equal(schema.ledger.length, 0);
    assert.equal(schema.executions.length, 0);
    assert.equal(schema.policy.resources.every((resource) => resource.capacity === 0 && resource.reserve === 0), true);
  }
});

test("accepts revisioned legacy documents for one-way migration", () => {
  const state = freshAppState();
  assert.equal(safeCloudWorkspaceDocument({ schemaVersion: CLOUD_SCHEMA_VERSION, revision: 1, state })?.revision, 1);
  assert.equal(safeCloudWorkspaceDocument({ schemaVersion: 5, revision: 1, state })?.revision, 1);
  assert.equal(safeCloudWorkspaceDocument({ schemaVersion: 4, revision: 1, state })?.revision, 1);
  assert.equal(safeCloudWorkspaceDocument({ schemaVersion: 3, revision: 1, state }), null);
  assert.equal(safeCloudWorkspaceDocument({ schemaVersion: CLOUD_SCHEMA_VERSION, revision: 0, state }), null);
});

test("round-trips segmented cloud state without breaking multibyte text", () => {
  const state = { data: structuredClone(defaultWorkspace), undo: {} }; state.data.policy.objective += " — deterministic ✓";
  const segments = segmentAppState(state, 1_000);
  assert.ok(segments.length > 1);
  assert.deepEqual(restoreSegmentedAppState(segments), firestoreAppState(state));
  assert.equal(restoreSegmentedAppState([...segments, ...Array(65).fill("x")]), null);
});

test("validates the segmented manifest contract", () => {
  assert.deepEqual(safeCloudWorkspaceManifest({ schemaVersion: CLOUD_SCHEMA_VERSION, revision: 2, segmentCount: 3, storageLayout: "segmented-v1" }), { revision: 2, segmentCount: 3 });
  assert.deepEqual(safeCloudWorkspaceManifest({ schemaVersion: 5, revision: 2, segmentCount: 3, storageLayout: "segmented-v1" }), { revision: 2, segmentCount: 3 });
  assert.equal(safeCloudWorkspaceManifest({ schemaVersion: CLOUD_SCHEMA_VERSION, revision: 2, segmentCount: 0, storageLayout: "segmented-v1" }), null);
});

test("normalises optional undefined values before Firestore writes", () => {
  const state = freshAppState(); state.data.policy.fields[0].unit = undefined;
  const normalised = firestoreAppState(state);
  assert.equal("unit" in normalised.data.policy.fields[0], false);
  assert.ok(safeAppState(normalised));
});

test("rejects stale whole-workspace writes instead of overwriting another client", () => {
  assert.equal(cloudWriteDecision("revision-two", "revision-one", "my-change"), "conflict");
  assert.equal(cloudWriteDecision("revision-one", "revision-one", "my-change"), "write");
  assert.equal(cloudWriteDecision("my-change", "revision-one", "my-change"), "noop");
});

test("migrates a legacy workspace without inventing undo history", () => {
  const migrated = safeLegacyAppState(defaultWorkspace);
  assert.equal(migrated?.data.cases.length, 12);
  assert.deepEqual(migrated?.undo, {});
});

test("migrates pre-execution workspaces with an empty durable execution history", () => {
  const legacy = structuredClone(defaultWorkspace) as Partial<WorkspaceData>;
  delete legacy.executions;
  const migrated = safeLegacyAppState(legacy);
  assert.deepEqual(migrated?.data.executions, []);
});
