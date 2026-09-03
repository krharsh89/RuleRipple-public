import assert from "node:assert/strict";
import test from "node:test";
import { externalExecutionAccounting, ledgerEventSequence } from "./execution-accounting.ts";
import {
  appendLedgerEvent,
  approveExternalExecution,
  createPolicyImpactReport,
  createSnapshot,
  nextId,
  proposeExternalExecution,
  reconcileResourceUsage,
  recordExternalExecution,
  type LedgerEvent,
  type PolicyRule,
  type TestCase,
  type WorkspaceData,
} from "./domain.ts";
import { defaultWorkspace } from "./preset-fixtures.test.ts";
import { policyTemplateWorkspace, presetById, unconfiguredWorkspace } from "./presets.ts";
import { createWebMCPTools, type CaseInput, type WebMCPActions } from "./webmcp-tools.ts";

function setup({ stageExecution = false, workspace = defaultWorkspace }: { stageExecution?: boolean; workspace?: WorkspaceData } = {}) {
  let data: WorkspaceData = structuredClone(workspace);
  let pendingRemoval: string | null = null;
  const actions: WebMCPActions = {
    createPolicy: (policy, resetWorkspace) => { data.policy = policy; data.presetId = "custom"; if (resetWorkspace) { data.rules = []; data.cases = []; data.ledger = []; data.executions = []; } return { value: policy, status: "applied" }; },
    addRule: (input) => { const rule: PolicyRule = { ...input, id: nextId("R", data.rules), enabled: true }; data.rules.push(rule); return { value: rule, status: "applied" }; },
    updateRule: (id, patch) => { const index = data.rules.findIndex((rule) => rule.id === id); if (index < 0) return null; data.rules[index] = { ...data.rules[index], ...patch }; return { value: data.rules[index], status: "applied" }; },
    requestRemoveRule: (id) => { const rule = data.rules.find((item) => item.id === id) ?? null; pendingRemoval = rule?.id ?? null; return rule; },
    upsertCases: (incoming: CaseInput[]) => ({ value: incoming.map((item) => {
      const existing = item.id ? data.cases.find((candidate) => candidate.id.toLowerCase() === item.id?.toLowerCase()) : data.cases.find((candidate) => candidate.name.toLowerCase() === item.name.toLowerCase());
      const saved: TestCase = { ...item, id: existing?.id ?? item.id ?? nextId("C", data.cases), actualUsage: existing?.actualUsage ?? {} };
      const index = data.cases.findIndex((candidate) => candidate.id === saved.id); if (index >= 0) data.cases[index] = saved; else data.cases.push(saved); return saved;
    }), status: "applied" }),
    saveVersion: (label, rationale) => { const id = nextId("V", data.versions); data.versions.push({ id, label, rationale, createdAt: new Date().toISOString(), snapshot: createSnapshot(data.policy, data.rules, data.cases) }); return id; },
    appendLedger: (input) => { const result = appendLedgerEvent(data, { ...input, actor: "agent" }); if (!stageExecution) data = result.workspace; return { value: result.event, status: stageExecution ? "pending_human_confirmation" : "applied", ...(stageExecution ? { proposalId: "PX-reserve" } : {}) }; },
    reconcileUsage: (requestId, resourceId, actualUsage, idempotencyKey) => { const next = reconcileResourceUsage(data, requestId, resourceId, actualUsage, "agent", idempotencyKey); if (!stageExecution) data = next; return { value: { requestId, resourceId, actualUsage }, status: stageExecution ? "pending_human_confirmation" : "applied", ...(stageExecution ? { proposalId: "PX-reconcile" } : {}) }; },
    proposeExternalExecution: (input) => { const result = proposeExternalExecution(data, input); data = result.workspace; return { value: result.execution, status: result.execution.status === "pending_approval" ? "pending_human_confirmation" : "applied", proposalId: result.execution.id }; },
    recordExternalExecution: (executionId, receipt) => { data = recordExternalExecution(data, executionId, receipt); return data.executions.find((item) => item.id === executionId)!; },
  };
  const tools = createWebMCPTools(() => ({ getData: () => data, actions }));
  const byName = (name: string) => tools.find((tool) => tool.name === name)!;
  return { byName, getData: () => data, getPendingRemoval: () => pendingRemoval, tools };
}

async function result(tool: ReturnType<ReturnType<typeof setup>["byName"]>, input: Record<string, unknown>) {
  const response = await tool.execute(input) as { content: Array<{ text: string }>; isError?: boolean };
  return { response, value: JSON.parse(response.content[0].text) as Record<string, unknown> };
}

test("exposes the complete nineteen-tool governed surface", () => {
  const { tools } = setup();
  assert.equal(tools.length, 19);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, 19);
  assert.deepEqual(tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name), [
    "get_request_inbox", "get_policy_summary", "evaluate_cases", "find_boundary_cases", "compare_policy_versions", "get_impact_reports", "get_resource_ledger", "get_external_execution",
  ]);
  for (const tool of tools) assert.ok(tool.description.length < 500);
});

test("exposes applied policy impact reports as addressable objects", async () => {
  const context = setup(); const baseline = createSnapshot(context.getData().policy, context.getData().rules, context.getData().cases); const candidate = structuredClone(baseline); candidate.policy.resources[0].capacity = 10000;
  context.getData().versions.push({ id: "V-04", label: "Capacity scenario", rationale: "Protect headroom.", createdAt: "2026-08-30T00:00:00.000Z", snapshot: candidate });
  context.getData().impactReports.push(createPolicyImpactReport({ id: "IR-01", label: "Capacity scenario", rationale: "Protect headroom.", actor: "human", approvedBy: "reviewer@example.com", baseline, candidate, baselineVersionId: "V-03", candidateVersionId: "V-04", createdAt: "2026-08-30T00:00:00.000Z" }));
  const listed = await result(context.byName("get_impact_reports"), {}); assert.equal((listed.value.reports as Array<{ id: string }>)[0].id, "IR-01"); assert.equal((listed.value.reports as Array<{ approved_by: string }>)[0].approved_by, "Workspace owner");
  const fetched = await result(context.byName("get_impact_reports"), { report_id: "IR-01" }); assert.equal(fetched.value.candidate_version_id, "V-04"); assert.equal(fetched.value.approved_by, "Workspace owner"); assert.equal(typeof fetched.value.rank_changes, "number"); assert.equal(fetched.value.truncated, undefined); const affected = fetched.value.affected_cases as Array<{ resources: unknown[] }>; assert.ok(affected.length <= 5); assert.ok(affected.every((item) => Array.isArray(item.resources)));
});

test("updates policy metadata and the current resource configuration", async () => {
  const context = setup();
  const { response } = await result(context.byName("create_policy"), {
    name: "Transparent Capacity Program", objective: "Allocate capacity transparently.",
    outcomes: { eligible: "Pass", boundary: "Near", review: "Review" },
    boundary: { tolerance: 0.1, maximum_failed_rules: 0 },
    scoring: { base: 25, minimum: 0, maximum: 200 },
    governance: { owner: "Capacity council", status: "active", effective_from: "2026-01-01", effective_until: "2026-12-31", require_approval: true, require_rationale: true },
    resource: { id: "funding", label: "Reference credits", unit: "credits", capacity: 50000, reserve: 5000, strategy: "partial", divisible: false },
  });
  assert.equal(response.isError, undefined);
  assert.equal(context.getData().policy.outcomes.eligible, "Pass");
  assert.equal(context.getData().policy.resources[0].capacity, 50000);
  assert.deepEqual(context.getData().policy.boundary, { tolerance: 0.1, maximumFailedRules: 0 });
  assert.deepEqual(context.getData().policy.scoring, { base: 25, minimum: 0, maximum: 200 });
  assert.equal(context.getData().policy.governance?.owner, "Capacity council");
});

test("policy summary exposes resolved settings and automatic audit findings", async () => {
  const context = setup();
  const rules = context.getData().rules; rules.push({ ...structuredClone(rules[0]), id: "R-99" });
  const { value } = await result(context.byName("get_policy_summary"), {});
  const policy = value.policy as Record<string, unknown>;
  assert.equal(typeof policy.boundary, "object");
  assert.equal(typeof policy.scoring, "object");
  assert.equal(typeof policy.governance, "object");
  assert.ok((value.policy_audit as Array<{ code: string }>).some((issue) => issue.code === "DUPLICATE_RULE"));
  assert.equal((value.simulation as { status: string }).status, "calculated_from_current_inputs");
  assert.deepEqual((value.external_actions as Array<{ action_id: string }>).map((action) => action.action_id), ["github.issue.add_labels", "github.issue.add_comment", "github.pull_request.merge"]);
  assert.deepEqual(value.execution_governance, { policy_applicable: true, approval_required: true, eligible_actions_are: "held_for_human_approval" });
  assert.equal(value.allocations, undefined);
});

test("policy summary does not report allocation-shaped totals before requests exist", async () => {
  const context = setup(); context.getData().cases = [];
  const { value } = await result(context.byName("get_policy_summary"), {});
  assert.equal(value.request_count, 0);
  assert.deepEqual(value.simulation, { status: "waiting_for_request_inputs", resources: [] });
  assert.equal(value.allocations, undefined);
});

test("request intake preserves attributable GitHub source provenance", async () => {
  const context = setup();
  const response = await result(context.byName("upsert_cases"), { cases: [{ case_id: "C-02", name: "Northside Cooling Hub", values: { readiness: 4, communityReach: 240, urgency: "medium" }, demands: { funding: 22000 }, minimums: { funding: 22000 }, source: { system: "github", external_id: "krharsh89/RuleRipple#42", url: "https://github.com/krharsh89/RuleRipple/issues/42" } }] });
  assert.equal(response.response.isError, undefined);
  assert.equal(context.getData().cases.find((item) => item.id === "C-02")?.source?.externalId, "krharsh89/RuleRipple#42");
});

test("request intake rejects mismatched or non-canonical GitHub provenance", async () => {
  const context = setup();
  const input = { case_id: "C-02", name: "Northside Cooling Hub", values: { readiness: 4, communityReach: 240, urgency: "medium" }, demands: { funding: 22000 }, minimums: { funding: 22000 } };
  const mismatched = await result(context.byName("upsert_cases"), { cases: [{ ...input, source: { system: "github", external_id: "krharsh89/RuleRipple#41", url: "https://github.com/krharsh89/RuleRipple/issues/42" } }] });
  assert.equal(mismatched.response.isError, true);
  assert.match(String(mismatched.value.error), /must match the canonical GitHub issue or pull-request URL/);
  const repositoryOnly = await result(context.byName("upsert_cases"), { cases: [{ ...input, source: { system: "github", external_id: "krharsh89/RuleRipple#42", url: "https://github.com/krharsh89/RuleRipple" } }] });
  assert.equal(repositoryOnly.response.isError, true);
});

test("external WebMCP flow waits for approval before exposing invocation authority", async () => {
  const context = setup();
  const source = { system: "github" as const, externalId: "krharsh89/RuleRipple#42", url: "https://github.com/krharsh89/RuleRipple/issues/42", importedAt: "2026-09-01T12:00:00.000Z" };
  context.getData().cases = context.getData().cases.map((item) => item.id === "C-02" ? { ...item, source } : item);
  context.getData().versions.at(-1)!.snapshot = createSnapshot(context.getData().policy, context.getData().rules, context.getData().cases);
  const proposed = await result(context.byName("propose_external_execution"), { request_id: "C-02", action_id: "github.issue.add_labels", action_arguments: { repository_full_name: "krharsh89/RuleRipple", issue_number: 42, labels: ["enhancement"] }, resource_id: "funding", authorized_amount: 1000, idempotency_key: "webmcp-github-42" });
  assert.equal(proposed.response.isError, undefined); assert.equal(proposed.value.status, "pending_human_confirmation");
  const id = (proposed.value.execution as { id: string }).id;
  const listed = await result(context.byName("get_external_execution"), {}); assert.equal((listed.value.executions as Array<{ id: string }>)[0].id, id);
  const waiting = await result(context.byName("get_external_execution"), { execution_id: id }); assert.equal(waiting.value.may_invoke_external_tool, false); assert.equal(waiting.value.invocation, null);
  Object.assign(context.getData(), approveExternalExecution(context.getData(), id, "reviewer@example.com"));
  const ready = await result(context.byName("get_external_execution"), { execution_id: id }); assert.equal(ready.value.may_invoke_external_tool, true); assert.equal((ready.value.invocation as { tool: string }).tool, "github_add_issue_labels"); assert.equal((ready.value.execution as { approvedBy: string }).approvedBy, "Workspace owner"); assert.equal((ready.value.ledger_state as { reserved: number }).reserved, 1000);
  const recorded = await result(context.byName("record_external_execution"), { execution_id: id, status: "succeeded", external_reference: "github:krharsh89/RuleRipple#42:label:enhancement", result_url: "https://github.com/krharsh89/RuleRipple/issues/42", summary: "GitHub confirmed the approved label change.", actual_usage: 600 });
  assert.equal(recorded.response.isError, undefined); assert.equal((recorded.value.execution as { status: string }).status, "succeeded"); assert.match(String(recorded.value.next_step), /unused authorization is released/);
  const detail = await result(context.byName("get_external_execution"), { execution_id: id }); assert.equal((detail.value.ledger_state as { consumed: number }).consumed, 600); assert.equal((detail.value.execution as { receipt: { actualUsage: number } }).receipt.actualUsage, 600);
  const completed = await result(context.byName("get_external_execution"), { status: "succeeded" }); assert.equal((completed.value.executions as Array<{ id: string }>)[0].id, id); assert.equal((completed.value.executions as Array<{ result: { actual_usage: number } }>)[0].result.actual_usage, 600);
});

test("external receipts distinguish historical action events from later request settlement", async () => {
  const context = setup();
  const data = context.getData();
  data.cases.find((item) => item.id === "C-02")!.source = { system: "github", externalId: "org/config#42", url: "https://github.com/org/config/issues/42", importedAt: "2026-09-03T00:00:00.000Z" };
  data.versions.at(-1)!.snapshot = createSnapshot(data.policy, data.rules, data.cases);
  const proposed = await result(context.byName("propose_external_execution"), { request_id: "C-02", action_id: "github.issue.add_labels", action_arguments: { repository_full_name: "org/config", issue_number: 42, labels: ["enhancement"] }, resource_id: "funding", authorized_amount: 1000, idempotency_key: "accounting-action" });
  const id = (proposed.value.execution as { id: string }).id;
  Object.assign(context.getData(), approveExternalExecution(context.getData(), id, "Workspace owner"));
  await result(context.byName("record_external_execution"), { execution_id: id, status: "succeeded", external_reference: "github:org/config#42:label:enhancement", result_url: "https://github.com/org/config/issues/42", summary: "Label applied." });
  const before = await result(context.byName("get_external_execution"), { execution_id: id });
  assert.deepEqual(before.value.request_ledger_state, { reserved: 0, committed: 1000, consumed: 0 });
  const reconciled = await result(context.byName("reconcile_resource_usage"), { request_id: "C-02", resource_id: "funding", actual_usage: 400, idempotency_key: "request-settlement" });
  assert.equal(reconciled.response.isError, undefined);
  const after = await result(context.byName("get_external_execution"), { execution_id: id });
  assert.equal(after.response.isError, undefined);
  assert.equal(after.value.ledger_scope, "execution_events_only");
  assert.deepEqual(after.value.ledger_state, { reserved: 0, committed: 1000, consumed: 0 });
  assert.deepEqual(after.value.request_ledger_state, { reserved: 0, committed: 0, consumed: 400 });
  assert.equal((after.value.execution as { receipt: { actualUsage?: number } }).receipt.actualUsage, undefined);
  assert.match(String(after.value.next_step), /current balances/);
  assert.doesNotMatch(String(after.value.next_step), /remains committed/);
  const execution = context.getData().executions.find((item) => item.id === id)!;
  assert.deepEqual(externalExecutionAccounting(context.getData(), execution).requestTotals, after.value.request_ledger_state);
});

test("ledger review summarizes the proposed events rather than a fixed sequence", () => {
  assert.equal(ledgerEventSequence([{ type: "commit" }, { type: "consume" }, { type: "release" }]), "commit → consume → release");
  assert.equal(ledgerEventSequence([{ type: "refund" }]), "refund");
  assert.equal(ledgerEventSequence([]), "No resource movement");
});

test("external proposals expose only connected GitHub action contracts", async () => {
  const context = setup();
  const source = { system: "github" as const, externalId: "krharsh89/RuleRipple#42", url: "https://github.com/krharsh89/RuleRipple/issues/42", importedAt: "2026-09-01T12:00:00.000Z" };
  context.getData().cases = context.getData().cases.map((item) => item.id === "C-02" ? { ...item, source } : item);
  context.getData().versions.at(-1)!.snapshot = createSnapshot(context.getData().policy, context.getData().rules, context.getData().cases);
  const comment = await result(context.byName("propose_external_execution"), { request_id: "C-02", action_id: "github.issue.add_comment", action_arguments: { repo_full_name: "krharsh89/RuleRipple", pr_number: 42, comment: "Approved through RuleRipple." }, resource_id: "funding", authorized_amount: 1000, idempotency_key: "webmcp-github-comment-42" });
  assert.equal(comment.response.isError, undefined);
  assert.equal((comment.value.execution as { tool: string }).tool, "github_add_comment_to_issue");
  const unsupported = await result(context.byName("propose_external_execution"), { request_id: "C-02", action_id: "github.copilot.assign_issue", action_arguments: { owner: "krharsh89", repo: "RuleRipple", issue_number: 42 }, resource_id: "funding", authorized_amount: 1000, idempotency_key: "unsupported-copilot" });
  assert.equal(unsupported.response.isError, true);
  assert.match(String(unsupported.value.error), /action_id must be one of/);
});

test("WebMCP can authorize an exact-SHA pull-request merge with the configured resource", async () => {
  const context = setup();
  const source = { system: "github" as const, externalId: "krharsh89/RuleRipple#12", url: "https://github.com/krharsh89/RuleRipple/pull/12", importedAt: "2026-09-02T06:00:00.000Z" };
  context.getData().cases = context.getData().cases.map((item) => item.id === "C-02" ? { ...item, source } : item);
  context.getData().versions.at(-1)!.snapshot = createSnapshot(context.getData().policy, context.getData().rules, context.getData().cases);
  const proposed = await result(context.byName("propose_external_execution"), { request_id: "C-02", action_id: "github.pull_request.merge", action_arguments: { repository_full_name: "krharsh89/RuleRipple", pr_number: 12, expected_head_sha: "b".repeat(40), merge_method: "squash" }, resource_id: "funding", authorized_amount: 1000, idempotency_key: "webmcp-github-merge-12" });
  assert.equal(proposed.response.isError, undefined);
  assert.equal(proposed.value.status, "pending_human_confirmation");
  assert.deepEqual(proposed.value.policy_check, { passed_at_proposal: true, policy_version_id: "V-03", request_outcome: "eligible", approval_required: true, authorization_mode: "human_approval", resource_amount_authorized: 1000 });
  assert.equal((proposed.value.execution as { tool: string }).tool, "github_merge_pull_request");
});

test("WebMCP surfaces policy-authorized automation when approval is disabled", async () => {
  const context = setup();
  const source = { system: "github" as const, externalId: "krharsh89/RuleRipple#42", url: "https://github.com/krharsh89/RuleRipple/issues/42", importedAt: "2026-09-02T06:00:00.000Z" };
  context.getData().policy.governance = { ...context.getData().policy.governance!, requireApproval: false };
  context.getData().cases = context.getData().cases.map((item) => item.id === "C-02" ? { ...item, source } : item);
  context.getData().versions.at(-1)!.snapshot = createSnapshot(context.getData().policy, context.getData().rules, context.getData().cases);
  const proposed = await result(context.byName("propose_external_execution"), { request_id: "C-02", action_id: "github.issue.add_labels", action_arguments: { repository_full_name: "krharsh89/RuleRipple", issue_number: 42, labels: ["enhancement"] }, resource_id: "funding", authorized_amount: 1000, idempotency_key: "webmcp-policy-authorized" });
  assert.equal(proposed.response.isError, undefined);
  assert.equal(proposed.value.status, "applied");
  assert.equal((proposed.value.policy_check as { authorization_mode: string }).authorization_mode, "policy_automatic");
  assert.match(String(proposed.value.next_step), /active policy authorized/i);
  const execution = proposed.value.execution as { id: string };
  const ready = await result(context.byName("get_external_execution"), { execution_id: execution.id });
  assert.equal(ready.value.may_invoke_external_tool, true);
  assert.equal((ready.value.ledger_state as { reserved: number }).reserved, 1000);
});

test("WebMCP never offers invocation for a claimed or stale approved action", async () => {
  const context = setup();
  const data = context.getData();
  data.cases.find((item) => item.id === "C-02")!.source = { system: "github", externalId: "krharsh89/RuleRipple#42", url: "https://github.com/krharsh89/RuleRipple/issues/42", importedAt: new Date().toISOString() };
  data.versions.at(-1)!.snapshot = createSnapshot(data.policy, data.rules, data.cases);
  const proposed = await result(context.byName("propose_external_execution"), { request_id: "C-02", action_id: "github.issue.add_labels", action_arguments: { repository_full_name: "krharsh89/RuleRipple", issue_number: 42, labels: ["enhancement"] }, resource_id: "funding", authorized_amount: 1000, idempotency_key: "claimed-webmcp" });
  const id = (proposed.value.execution as { id: string }).id;
  Object.assign(context.getData(), approveExternalExecution(context.getData(), id, "Owner"));
  context.getData().executions[0].attempt = { id: "claim", startedAt: new Date().toISOString(), state: "uncertain" };
  const claimed = await result(context.byName("get_external_execution"), { execution_id: id });
  assert.equal(claimed.value.may_invoke_external_tool, false);
  assert.equal(claimed.value.invocation, null);
  const list = await result(context.byName("get_external_execution"), {});
  assert.equal((list.value.executions as Array<{may_invoke_external_tool:boolean}>)[0].may_invoke_external_tool, false);
  delete context.getData().executions[0].attempt;
  context.getData().policy.name = "Changed policy";
  const stale = await result(context.byName("get_external_execution"), { execution_id: id });
  assert.equal(stale.value.may_invoke_external_tool, false);
});

test("WebMCP cannot dispatch or manufacture receipts for a built-in batch action", async () => {
  const context = setup(); let data = context.getData();
  data.cases.find((item) => item.id === "C-02")!.source = { system: "github", externalId: "krharsh89/RuleRipple#12", url: "https://github.com/krharsh89/RuleRipple/pull/12", importedAt: new Date().toISOString() };
  data.versions.at(-1)!.snapshot = createSnapshot(data.policy, data.rules, data.cases);
  const proposed = await result(context.byName("propose_external_execution"), { request_id: "C-02", action_id: "github.pull_request.merge", action_arguments: { repository_full_name: "krharsh89/RuleRipple", pr_number: 12, expected_head_sha: "b".repeat(40), merge_method: "squash" }, resource_id: "funding", authorized_amount: 1000, idempotency_key: "batch-owned" });
  const id = (proposed.value.execution as { id: string }).id;
  data = context.getData();
  Object.assign(data, approveExternalExecution(data, id, "Owner"));
  data.batches = [{ id: "B-01", createdAt: new Date().toISOString(), policyVersionId: "V-03", portfolioFingerprint: "sha256-" + "a".repeat(64), resourceId: "funding", unit: "credits", availableAtReview: 10000, rows: [{ source: "krharsh89/RuleRipple#12", url: "https://github.com/krharsh89/RuleRipple/pull/12", headSha: "b".repeat(40), requestId: "C-02", sourceFingerprint: "sha256-" + "a".repeat(64), name: "Workflow", outcome: "eligible", rank: 1, simulated: 1000, authorization: 1000, reason: "Funded", executionId: id }] }];
  const detail = await result(context.byName("get_external_execution"), { execution_id: id });
  assert.equal(detail.value.may_invoke_external_tool, false);
  assert.equal(detail.value.invocation, null);
  assert.match(String(detail.value.next_step), /built-in executor/);
  const receipt = await result(context.byName("record_external_execution"), { execution_id: id, status: "succeeded", external_reference: "unverified", summary: "Unverified receipt" });
  assert.equal(receipt.response.isError, true);
  assert.equal(data.executions[0].status, "approved");
});

test("fresh workspaces require a complete explicit policy before WebMCP can stage data", async () => {
  const context = setup({ workspace: unconfiguredWorkspace() });
  const summary = await result(context.byName("get_policy_summary"), {});
  assert.deepEqual(summary.value.configuration, {
    status: "required",
    required_inputs: ["outcomes", "boundary", "scoring", "governance", "resource or resources with positive capacity", "fields", "ranking"],
  });
  assert.equal((summary.value.policy as { status: string }).status, "not_active");
  assert.equal(JSON.stringify(summary.value.policy).includes('"capacity"'), false);
  assert.deepEqual(summary.value.simulation, { status: "waiting_for_policy_configuration", resources: [] });

  const incomplete = await result(context.byName("create_policy"), { name: "Incomplete", objective: "Must not inherit placeholders." });
  assert.equal(incomplete.response.isError, true);
  assert.match(String(incomplete.value.error), /workspace is unconfigured/);

  const prematureRequest = await result(context.byName("upsert_cases"), { cases: [{ name: "Request", values: { input: 1 }, demands: { resource: 1 } }] });
  assert.equal(prematureRequest.response.isError, true);
  assert.match(String(prematureRequest.value.error), /Policy configuration is required first/);

  const configured = await result(context.byName("create_policy"), {
    name: "Compute access", objective: "Allocate a stated compute envelope.",
    outcomes: { eligible: "Approved", boundary: "Near threshold", review: "Review" },
    fields: [{ key: "readiness", label: "Readiness", type: "integer", min: 0, max: 5 }],
    resources: [{ id: "hours", label: "Compute hours", unit: "hours", capacity: 25000, reserve: 2500, strategy: "partial", divisible: true }],
    primary_resource_id: "hours", ranking: [{ source: "score", direction: "desc" }, { source: "demand", key: "hours", direction: "asc" }],
    boundary: { tolerance: 0.1, maximum_failed_rules: 1 }, scoring: { base: 0, minimum: 0, maximum: 100 },
    governance: { owner: "Operations", status: "active", require_approval: true, require_rationale: true },
  });
  assert.equal(configured.response.isError, undefined);
  assert.equal(configured.value.reset_workspace, false);
  assert.equal(context.getData().policy.resources[0].capacity, 25000);
  const configuredSummary = await result(context.byName("get_policy_summary"), {});
  assert.equal((configuredSummary.value.configuration as { status: string }).status, "configured");
});

test("Team API Quota requires an explicit rate window in UI and WebMCP configuration", async () => {
  const template = policyTemplateWorkspace(presetById("api-quota")!);
  const context = setup({ workspace: template });
  const summary = await result(context.byName("get_policy_summary"), {});
  assert.ok((summary.value.configuration as { required_inputs: string[] }).required_inputs.includes("rate window for api-calls"));
  const baseInput = {
    name: "Team API Quota", objective: "Allocate an explicit API-call quota.",
    outcomes: { eligible: "Eligible", boundary: "Boundary", review: "Review" },
    resource: { id: "api-calls", label: "Daily API quota", unit: "calls", capacity: 1000, reserve: 100, strategy: "rate_limit", divisible: false },
    boundary: { tolerance: 0.1, maximum_failed_rules: 1 }, scoring: { base: 50, minimum: 0, maximum: 100 },
    governance: { owner: "Platform operations", status: "draft", require_approval: true, require_rationale: true },
  };
  const missing = await result(context.byName("create_policy"), baseInput);
  assert.equal(missing.response.isError, true);
  assert.match(String(missing.value.error), /window_seconds is required/);
  const configured = await result(context.byName("create_policy"), { ...baseInput, resource: { ...baseInput.resource, window_seconds: 86_400 } });
  assert.equal(configured.response.isError, undefined);
  assert.equal(context.getData().policy.resources[0].windowSeconds, 86_400);
});

test("rejects a resource identity change that would orphan existing rules", async () => {
  const context = setup();
  const { response, value } = await result(context.byName("create_policy"), {
    name: "Bad replacement", objective: "Would orphan existing data.",
    resource: { id: "new-pool", label: "New", unit: "units", capacity: 10, reserve: 0, strategy: "slot", divisible: false },
  });
  assert.equal(response.isError, true);
  assert.match(String(value.error), /reset_workspace: true/);
});

test("schema reset cannot erase execution evidence", async () => {
  const context = setup();
  const reserved = await result(context.byName("reserve_resource"), { request_id: "C-04", resource_id: "funding", amount: 1000, idempotency_key: "preserve-ledger" });
  assert.equal(reserved.response.isError, undefined);
  const reset = await result(context.byName("create_policy"), { name: context.getData().policy.name, objective: context.getData().policy.objective, reset_workspace: true });
  assert.equal(reset.response.isError, true);
  assert.match(String(reset.value.error), /cannot erase ledger or external execution evidence/);
  assert.equal(context.getData().ledger.length, 1);
});

test("installs a complete plug-and-play multi-resource policy with explicit reset", async () => {
  const context = setup();
  const { response } = await result(context.byName("create_policy"), {
    name: "Agent Operations", objective: "Allocate credits and concurrency slots.", outcomes: { eligible: "Approved", boundary: "Near", review: "Review" },
    fields: [{ key: "tier", label: "Service tier", type: "enum", options: ["standard", "priority"] }],
    resources: [
      { id: "credits", label: "Credits", unit: "credits", capacity: 100000, reserve: 10000, strategy: "partial", divisible: false },
      { id: "slots", label: "Concurrent slots", unit: "slots", capacity: 20, reserve: 2, strategy: "slot", divisible: false },
    ],
    primary_resource_id: "credits", ranking: [{ source: "field", key: "tier", direction: "desc" }, { source: "demand", key: "credits", direction: "asc" }], reset_workspace: true,
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(context.getData().policy.resources.map((resource) => resource.id), ["credits", "slots"]);
  assert.equal(context.getData().rules.length, 0);
  assert.equal(context.getData().cases.length, 0);
});

test("adds a compound typed rule", async () => {
  const context = setup();
  const { response, value } = await result(context.byName("add_rule"), {
    label: "Urgent ready proposal", kind: "score", points: 15, match: "all",
    conditions: [{ field: "urgency", operator: "eq", value: "high" }, { field: "readiness", operator: "gte", value: 4 }],
  });
  assert.equal(response.isError, undefined);
  assert.equal((value.rule as PolicyRule).conditions.length, 2);
});

test("rejects incompatible numeric comparisons", async () => {
  const context = setup();
  const { response, value } = await result(context.byName("add_rule"), {
    label: "Bad urgency", kind: "threshold", conditions: [{ field: "urgency", operator: "gte", value: "high" }],
  });
  assert.equal(response.isError, true);
  assert.match(String(value.error), /numeric comparison/);
  const numericLooking = await result(context.byName("add_rule"), { label: "Still bad urgency", kind: "threshold", conditions: [{ field: "urgency", operator: "gte", value: 1 }] });
  assert.equal(numericLooking.response.isError, true);
  assert.match(String(numericLooking.value.error), /equality or membership/);
});

test("runtime validation rejects coercion, truncation, and unknown request fields", async () => {
  const context = setup();
  const coerced = await result(context.byName("reserve_resource"), { request_id: "C-04", resource_id: "funding", amount: "1000", idempotency_key: "coerced" });
  assert.equal(coerced.response.isError, true);
  assert.match(String(coerced.value.error), /must be a number/);
  const coercedBoolean = await result(context.byName("update_rule"), { rule_id: "R-01", enabled: "false" });
  assert.equal(coercedBoolean.response.isError, true);
  assert.match(String(coercedBoolean.value.error), /enabled must be boolean/);
  assert.equal(context.getData().rules.find((rule) => rule.id === "R-01")?.enabled, true);
  const coercedReset = await result(context.byName("create_policy"), { name: "Same policy", objective: "No coercion.", reset_workspace: "true" });
  assert.equal(coercedReset.response.isError, true);
  assert.match(String(coercedReset.value.error), /reset_workspace must be boolean/);
  const coercedResource = await result(context.byName("get_resource_ledger"), { resource_id: 0 });
  assert.equal(coercedResource.response.isError, true);
  assert.match(String(coercedResource.value.error), /resource_id must be a non-empty string/);
  const fractionalLimit = await result(context.byName("find_boundary_cases"), { max_results: 1.5 });
  assert.equal(fractionalLimit.response.isError, true);
  assert.match(String(fractionalLimit.value.error), /max_results must be an integer/);
  const overlong = await result(context.byName("add_rule"), { label: "x".repeat(81), kind: "threshold", conditions: [{ field: "readiness", operator: "gte", value: 3 }] });
  assert.equal(overlong.response.isError, true);
  assert.match(String(overlong.value.error), /at most 80/);
  const extraField = genericCase(); (extraField.values as Record<string, unknown>).unknown = "surprise";
  const unknown = await result(context.byName("upsert_cases"), { cases: [extraField] });
  assert.equal(unknown.response.isError, true);
  assert.match(String(unknown.value.error), /Unknown request fields/);
});

test("boundary search returns enough rule evidence for an agent to explain and revise the threshold", async () => {
  const context = setup();
  const { value } = await result(context.byName("find_boundary_cases"), { max_results: 1 });
  const item = (value as unknown as Array<Record<string, unknown>>)[0];
  assert.equal(typeof item.request_name, "string");
  assert.equal(typeof item.rule_label, "string");
  assert.equal(typeof item.field, "string");
  assert.ok(["lt", "lte", "gt", "gte"].includes(String(item.operator)));
  assert.equal(typeof item.actual_value, "number");
  assert.equal(typeof item.threshold_value, "number");
  assert.equal(typeof item.passed, "boolean");
});

test("evaluate_cases returns generic traces and multi-resource allocations", async () => {
  const context = setup();
  const { value } = await result(context.byName("evaluate_cases"), { case_ids: ["C-01"] });
  const item = (value.cases as Array<Record<string, unknown>>)[0];
  assert.ok(Array.isArray(item.trace));
  const trace = item.trace as Array<Record<string, unknown>>;
  assert.equal(typeof trace[0].kind, "string");
  assert.equal(typeof trace[0].matched, "boolean");
  assert.ok(["passed", "failed", "applied", "not_applied"].includes(String(trace[0].effect)));
  assert.equal(typeof item.allocation, "object");
  assert.equal(typeof (item.allocation as { resources: unknown }).resources, "object");
  assert.equal(value.total, 1);
  assert.equal(value.next_offset, null);
});

test("evaluate_cases paginates the portfolio without replacing data with a truncated preview", async () => {
  const context = setup();
  const first = await result(context.byName("evaluate_cases"), {});
  assert.equal(first.value.truncated, undefined);
  assert.equal((first.value.cases as unknown[]).length, 3);
  assert.equal(first.value.total, context.getData().cases.length);
  assert.equal(first.value.next_offset, 3);

  const second = await result(context.byName("evaluate_cases"), { offset: 3, limit: 2 });
  assert.equal(second.value.offset, 3);
  assert.equal((second.value.cases as unknown[]).length, 2);
});

test("evaluate_cases rejects unknown request IDs", async () => {
  const context = setup();
  const { response, value } = await result(context.byName("evaluate_cases"), { case_ids: ["C-DOES-NOT-EXIST"] });
  assert.equal(response.isError, true);
  assert.match(String(value.error), /unknown case ids/i);
});

test("remove_rule only stages a human confirmation", async () => {
  const context = setup(); const before = context.getData().rules.length;
  const { value } = await result(context.byName("remove_rule"), { rule_id: "R-01" });
  assert.equal(value.status, "pending_human_confirmation");
  assert.equal(context.getPendingRemoval(), "R-01");
  assert.equal(context.getData().rules.length, before);
});

const genericCase = (overrides: Record<string, unknown> = {}) => ({
  name: "Transparent request", values: { readiness: 4, communityReach: 321, urgency: "high" },
  demands: { funding: 4321 }, minimums: { funding: 2000 }, ...overrides,
});

test("validates generic upsert identities and configured maps", async () => {
  const context = setup();
  const duplicate = genericCase({ case_id: "C-20" });
  const batch = await result(context.byName("upsert_cases"), { cases: [duplicate, { ...duplicate, name: "Second" }] });
  assert.equal(batch.response.isError, true);
  assert.match(String(batch.value.error), /unique within a batch/i);

  const unknown = await result(context.byName("upsert_cases"), { cases: [genericCase({ demands: { funding: 100, secret: 1 } })] });
  assert.equal(unknown.response.isError, true);
  assert.match(String(unknown.value.error), /not a configured resource/i);

  const zeroDemand = await result(context.byName("upsert_cases"), { cases: [genericCase({ demands: { funding: 0 }, minimums: { funding: 0 } })] });
  assert.equal(zeroDemand.response.isError, true);
  assert.match(String(zeroDemand.value.error), /greater than zero/i);

  const fractional = await result(context.byName("upsert_cases"), { cases: [genericCase({ demands: { funding: 10.5 }, minimums: { funding: 1 } })] });
  assert.equal(fractional.response.isError, true);
  assert.match(String(fractional.value.error), /whole USD/i);
});

test("rejects a new ID that reuses an existing request name", async () => {
  const context = setup(); const existing = context.getData().cases[0];
  const { response, value } = await result(context.byName("upsert_cases"), { cases: [genericCase({ case_id: "C-99", name: existing.name })] });
  assert.equal(response.isError, true);
  assert.match(String(value.error), /conflicts with existing/i);
});

test("updates an existing request by name when case_id is omitted", async () => {
  const context = setup(); const existing = context.getData().cases[0]; const beforeCount = context.getData().cases.length;
  const { response, value } = await result(context.byName("upsert_cases"), { cases: [genericCase({ name: existing.name })] });
  assert.equal(response.isError, undefined);
  assert.deepEqual(value.requests, [{ id: existing.id, name: existing.name }]);
  assert.deepEqual(value.saved, [{ id: existing.id, name: existing.name }]);
  assert.equal(context.getData().cases.length, beforeCount);
  assert.equal(context.getData().cases[0].demands.funding, 4321);
});

test("supports an ordered revise-save-compare journey", async () => {
  const context = setup();
  await result(context.byName("update_rule"), { rule_id: "R-03", conditions: [{ field: "communityReach", operator: "gte", value: 80 }] });
  const saved = await result(context.byName("save_policy_version"), { label: "Reach 80", rationale: "Review boundary effect." });
  assert.equal(saved.value.version_id, "V-04");
  const compared = await result(context.byName("compare_policy_versions"), { baseline_version_id: "V-03", candidate_version_id: "current" });
  assert.ok(Array.isArray(compared.value.changed_cases));
  assert.ok(Array.isArray(compared.value.changed_ranks));
  assert.ok(Array.isArray(compared.value.changed_allocations));
  assert.equal(typeof compared.value.rank_change_count, "number");
});

test("saved-version rationale follows policy governance", async () => {
  const optional = setup(); optional.getData().policy.governance = { owner: "Policy team", status: "active", requireApproval: false, requireRationale: false };
  const saved = await result(optional.byName("save_policy_version"), { label: "Optional rationale" });
  assert.equal(saved.response.isError, undefined);
  assert.equal(optional.getData().versions.at(-1)?.rationale, "No rationale required by policy.");

  const required = setup();
  const rejected = await result(required.byName("save_policy_version"), { label: "Missing rationale" });
  assert.equal(rejected.response.isError, true);
  assert.match(String(rejected.value.error), /rationale is required/);
});

test("resource ledger tools reserve idempotently and reconcile actual usage", async () => {
  const context = setup();
  const reservation = { request_id: "C-04", resource_id: "funding", amount: 1000, idempotency_key: "reservation-1" };
  await result(context.byName("reserve_resource"), reservation);
  await result(context.byName("reserve_resource"), reservation);
  assert.equal(context.getData().ledger.length, 1);
  const ledger = await result(context.byName("get_resource_ledger"), { resource_id: "funding" });
  assert.equal(((ledger.value as unknown as Array<{ state: { reserved: number } }>)[0]).state.reserved, 1000);

  const fresh = setup();
  const reconciled = await result(fresh.byName("reconcile_resource_usage"), { request_id: "C-04", resource_id: "funding", actual_usage: 10000, idempotency_key: "usage-1" });
  assert.equal(reconciled.response.isError, undefined);
  assert.deepEqual(fresh.getData().ledger.map((item: LedgerEvent) => item.type), ["reserve", "commit", "consume", "release"]);
});

test("resource tools surface pending human approval without mutating the ledger", async () => {
  const reservation = setup({ stageExecution: true });
  const reserved = await result(reservation.byName("reserve_resource"), { request_id: "C-04", resource_id: "funding", amount: 1000, idempotency_key: "pending-reservation" });
  assert.equal(reserved.value.status, "pending_human_confirmation");
  assert.equal(reserved.value.proposal_id, "PX-reserve");
  assert.equal(reservation.getData().ledger.length, 0);

  const reconciliation = setup({ stageExecution: true });
  const reconciled = await result(reconciliation.byName("reconcile_resource_usage"), { request_id: "C-04", resource_id: "funding", actual_usage: 10000, idempotency_key: "pending-usage" });
  assert.equal(reconciled.value.status, "pending_human_confirmation");
  assert.equal(reconciled.value.proposal_id, "PX-reconcile");
  assert.equal(reconciliation.getData().ledger.length, 0);
});

test("resource mutations are blocked when policy governance is not executable", async () => {
  const context = setup();
  context.getData().policy.governance = { ...context.getData().policy.governance!, status: "draft" };
  const reserved = await result(context.byName("reserve_resource"), { request_id: "C-04", resource_id: "funding", amount: 1000, idempotency_key: "blocked-1" });
  assert.equal(reserved.response.isError, true);
  assert.match(String(reserved.value.error), /still draft/);
  assert.equal(context.getData().ledger.length, 0);
});

test("every response remains valid JSON and below the output cap", async () => {
  const context = setup();
  const response = await context.byName("evaluate_cases").execute({}) as { content: Array<{ text: string }> };
  const parsed = JSON.parse(response.content[0].text) as { truncated?: boolean };
  assert.equal(parsed.truncated, undefined);
  assert.ok(response.content[0].text.length < 1500);
});

test("default read journeys return complete structured JSON instead of fallback previews", async () => {
  const context = setup();
  const calls: Array<[string, Record<string, unknown>]> = [
    ["get_policy_summary", {}],
    ["evaluate_cases", {}],
    ["find_boundary_cases", {}],
    ["compare_policy_versions", { baseline_version_id: "V-01" }],
    ["get_impact_reports", {}],
    ["get_resource_ledger", {}],
  ];
  for (const [name, input] of calls) {
    const response = await context.byName(name).execute(input) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(response.content[0].text) as { truncated?: boolean };
    assert.equal(parsed.truncated, undefined, `${name} should return a complete bounded result`);
    assert.ok(response.content[0].text.length < 4000, `${name} should stay below the documented cap`);
  }
});
