import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultWorkspace } from "./preset-fixtures.test.ts";
import { createWebMCPTools, type WebMCPActions } from "./webmcp-tools.ts";
import { agentPolicySetupSteps, agentRequestSetupSteps, agentWorkflowSteps, agentWorkflowStepsForWorkspace } from "./agent-workflow.ts";

const inertActions: WebMCPActions = {
  createPolicy: () => ({ value: defaultWorkspace.policy, status: "applied" as const }),
  addRule: () => ({ value: defaultWorkspace.rules[0], status: "applied" as const }),
  updateRule: () => ({ value: defaultWorkspace.rules[0], status: "applied" as const }),
  requestRemoveRule: () => defaultWorkspace.rules[0],
  upsertCases: () => ({ value: [], status: "applied" as const }),
  saveVersion: () => "V-04",
  appendLedger: () => ({ value: { id: "L-01", idempotencyKey: "eval", requestId: "C-01", resourceId: "funding", type: "reserve" as const, amount: 1, createdAt: new Date().toISOString(), actor: "agent" as const, note: "eval" }, status: "applied" }),
  reconcileUsage: (requestId, resourceId, actualUsage) => ({ value: { requestId, resourceId, actualUsage }, status: "applied" }),
  proposeExternalExecution: () => { throw new Error("not used in static agent evals"); },
  recordExternalExecution: () => { throw new Error("not used in static agent evals"); },
};
const tools = createWebMCPTools(() => ({ getData: () => defaultWorkspace, actions: inertActions }));
const names = new Set(tools.map((tool) => tool.name));
const journeys = JSON.parse(readFileSync(new URL("../evals/agent-journeys.json", import.meta.url), "utf8")) as Array<{ id: string; prompt: string; expected_tools: string[]; forbidden_tools: string[] }>;

test("agent journey fixtures reference only available tools", () => {
  for (const journey of journeys) {
    for (const name of [...journey.expected_tools, ...journey.forbidden_tools]) assert.ok(names.has(name), `${journey.id}: unknown tool ${name}`);
    assert.equal(new Set(journey.expected_tools).size, journey.expected_tools.length, `${journey.id}: duplicate expected call`);
  }
});

test("read-only tools and mutation tools are unambiguous", () => {
  const readOnly = tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name).sort();
  assert.deepEqual(readOnly, ["compare_policy_versions", "evaluate_cases", "find_boundary_cases", "get_external_execution", "get_impact_reports", "get_policy_summary", "get_request_inbox", "get_resource_ledger"]);
  for (const tool of tools) assert.equal(tool.name.length < 30, true);
});

test("visible agent workflow prompts match the evaluated journeys", () => {
  const journeyIds = ["credit-agent-inspection", "credit-governed-proposal", "impact-report-audit", "external-action-proposal", "external-action-completion"];
  assert.deepEqual(journeyIds.map((id) => journeys.find((journey) => journey.id === id)?.prompt), agentWorkflowSteps.map((step) => step.prompt));
});

test("visible agent prompts follow workspace readiness instead of assuming data exists", () => {
  assert.equal(agentWorkflowStepsForWorkspace(0, 0), agentPolicySetupSteps);
  assert.equal(agentWorkflowStepsForWorkspace(1, 0), agentRequestSetupSteps);
  assert.equal(agentWorkflowStepsForWorkspace(1, 1), agentWorkflowSteps);
  assert.match(agentPolicySetupSteps[1].prompt, /Do not invent/);
  assert.match(agentPolicySetupSteps[2].prompt, /configured authorization path/);
  assert.match(agentRequestSetupSteps[1].prompt, /Do not infer, preload, or invent/);
  assert.match(agentWorkflowSteps[2].prompt, /resource amounts/);
  assert.doesNotMatch(agentWorkflowSteps[2].prompt, /credits/i);
});
