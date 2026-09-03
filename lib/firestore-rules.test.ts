import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");

test("Firestore policy pins workspace ownership and schema version", () => {
  assert.match(rules, /request\.auth\.uid == userId/);
  assert.match(rules, /schemaVersion == 5/);
  assert.match(rules, /ownerId == userId/);
  assert.match(rules, /ownerEmail == request\.auth\.token\.email/);
});

test("Firestore policy constrains manifests, revisions, and owned segments", () => {
  assert.match(rules, /request\.resource\.data\.keys\(\)\.hasOnly/);
  assert.match(rules, /'segmentCount', 'storageLayout'/);
  assert.match(rules, /storageLayout == 'segmented-v1'/);
  assert.match(rules, /match \/segments\/\{segmentId\}/);
  assert.match(rules, /keys\(\)\.hasOnly\(\['ownerId', 'index', 'payload'\]\)/);
  assert.match(rules, /request\.resource\.data\.index < 64/);
  assert.match(rules, /segmentId\.matches\('\^\[0-9\]\{3\}\$'\)/);
  assert.match(rules, /payload\.size\(\) <= 450000/);
  assert.match(rules, /updatedAt is timestamp/);
  assert.match(rules, /revision == resource\.data\.revision \+ 1/);
});

test("notification receipts have an owner-scoped, bounded signed store separate from budgets", () => {
  assert.match(rules, /match \/agentNotifications\/\{notificationId\}/);
  assert.match(rules, /keys\(\)\.hasOnly\(\['ownerId', 'payload', 'signature'\]\)/);
  assert.match(rules, /payload\.size\(\) <= 6000/);
  assert.match(rules, /signature\.matches/);
});
