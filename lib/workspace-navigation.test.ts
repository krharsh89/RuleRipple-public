import test from "node:test";
import assert from "node:assert/strict";
import { assistantSuggestion, navigationGroups, workspaceSections } from "./workspace-navigation.ts";

test("navigation preserves all existing workspace surfaces exactly once", () => {
  assert.deepEqual(workspaceSections.map((s) => s.id).sort(), ["activity", "canvas", "cases", "executions", "impact", "inbox", "ledger", "operator", "versions"]);
  assert.ok(workspaceSections.every((s) => navigationGroups.includes(s.group)));
  assert.equal(workspaceSections.find((s) => s.id === "operator")?.label, "Connections");
});

test("assistant starting questions are bounded and read-only on every surface", () => {
  for (const section of workspaceSections) {
    const prompt = assistantSuggestion(section.id);
    assert.ok(prompt.length <= 600);
    assert.match(prompt, /Do not change anything\./);
    assert.doesNotMatch(prompt, /merge|execute|approve/i);
  }
});
