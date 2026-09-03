import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateResources,
  approveExternalExecution,
  appendLedgerEvent,
  auditPolicy,
  cancelExternalExecution,
  compareRuleSets,
  compareSimulationSnapshots,
  createPolicyImpactReport,
  createSnapshot,
  evaluateAll,
  evaluateCase,
  findBoundaryCases,
  governancePolicy,
  nextRuleId,
  outcomeCounts,
  policyExecutionIssues,
  proposeExternalExecution,
  reconcileResourceUsage,
  recordExternalExecution,
  rejectExternalExecution,
  resourceLedgerState,
  ruleValueDiffers,
  safeWorkspace,
  validateRule,
  WORKSPACE_LIMITS,
  type PolicyImpactReport,
  type PolicyRule,
  type ExternalExecutionProposalInput,
  type TestCase,
} from "./domain.ts";
import { defaultCases, defaultPolicy, defaultRules, defaultWorkspace, presetById } from "./preset-fixtures.test.ts";
import { policyTemplateWorkspace, simulationPresets, workspaceNeedsConfiguration } from "./presets.ts";

test("evaluates the deterministic seed dataset", () => {
  const evaluations = evaluateAll(defaultCases, defaultRules, defaultPolicy);
  assert.equal(evaluations.length, 12);
  assert.deepEqual(outcomeCounts(evaluations), { eligible: 6, boundary: 5, review: 1 });
});

const githubExecutionInput = (overrides: Partial<ExternalExecutionProposalInput> = {}): ExternalExecutionProposalInput => ({
  requestId: "C-02",
  actionId: "github.issue.add_labels",
  arguments: { repository_full_name: "krharsh89/RuleRipple", issue_number: 42, labels: ["enhancement"] },
  resourceId: "funding",
  authorizedAmount: 1000,
  idempotencyKey: "github-rule-ripple-42",
  ...overrides,
});

const githubWorkspace = () => {
  const workspace = structuredClone(defaultWorkspace);
  const source = { system: "github" as const, externalId: "krharsh89/RuleRipple#42", url: "https://github.com/krharsh89/RuleRipple/issues/42", importedAt: "2026-09-01T12:00:00.000Z" };
  workspace.cases = workspace.cases.map((item) => item.id === "C-02" ? { ...item, source } : item);
  workspace.versions[workspace.versions.length - 1].snapshot = createSnapshot(workspace.policy, workspace.rules, workspace.cases);
  return workspace;
};

const githubPullRequestWorkspace = () => {
  const workspace = githubWorkspace();
  const source = { system: "github" as const, externalId: "krharsh89/RuleRipple#12", url: "https://github.com/krharsh89/RuleRipple/pull/12", importedAt: "2026-09-02T06:00:00.000Z" };
  workspace.cases = workspace.cases.map((item) => item.id === "C-02" ? { ...item, source } : item);
  workspace.versions[workspace.versions.length - 1].snapshot = createSnapshot(workspace.policy, workspace.rules, workspace.cases);
  return workspace;
};

const githubMergeInput = (overrides: Partial<ExternalExecutionProposalInput> = {}): ExternalExecutionProposalInput => ({
  requestId: "C-02",
  actionId: "github.pull_request.merge",
  arguments: { repository_full_name: "krharsh89/RuleRipple", pr_number: 12, expected_head_sha: "a".repeat(40), merge_method: "squash" },
  resourceId: "funding",
  authorizedAmount: 1000,
  idempotencyKey: "github-rule-ripple-merge-12",
  ...overrides,
});

test("external execution proposals are bounded, durable, and idempotent", () => {
  const workspace = githubWorkspace();
  const proposed = proposeExternalExecution(workspace, githubExecutionInput());
  assert.equal(proposed.execution.status, "pending_approval");
  assert.equal(proposed.execution.tool, "github_add_issue_labels");
  assert.equal(proposed.execution.policyVersionId, "V-03");
  assert.ok(safeWorkspace(proposed.workspace));
  const duplicate = proposeExternalExecution(proposed.workspace, githubExecutionInput());
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.execution.id, proposed.execution.id);
  assert.throws(() => proposeExternalExecution(proposed.workspace, githubExecutionInput({ authorizedAmount: 1001 })), /different external execution/);
});

test("saved external executions migrate to the explicit human-approval mode", () => {
  const proposed = proposeExternalExecution(githubWorkspace(), githubExecutionInput()).workspace;
  const legacy = structuredClone(proposed) as unknown as { executions: Array<Record<string, unknown>> };
  delete legacy.executions[0].authorizationMode;
  const restored = safeWorkspace(legacy);
  assert.equal(restored?.executions[0].authorizationMode, "human_approval");
});

test("external issue comments use the connected GitHub tool contract", () => {
  const proposed = proposeExternalExecution(githubWorkspace(), githubExecutionInput({
    actionId: "github.issue.add_comment",
    arguments: { repo_full_name: "krharsh89/RuleRipple", pr_number: 42, comment: "Approved by the RuleRipple policy owner." },
    idempotencyKey: "github-rule-ripple-comment-42",
  }));
  assert.equal(proposed.execution.tool, "github_add_comment_to_issue");
  assert.deepEqual(proposed.execution.arguments, { pr_number: 42, repo_full_name: "krharsh89/RuleRipple", comment: "Approved by the RuleRipple policy owner." });
  assert.ok(safeWorkspace(proposed.workspace));
  assert.throws(() => proposeExternalExecution(githubWorkspace(), githubExecutionInput({
    actionId: "github.issue.add_comment",
    arguments: { repo_full_name: "krharsh89/RuleRipple", pr_number: 41, comment: "Wrong issue." },
    idempotencyKey: "github-rule-ripple-comment-wrong-target",
  })), /target must match/);
});

test("pull-request merges are allow-listed and pinned to the exact inspected head SHA", () => {
  const sourceFingerprint = `sha256-${"b".repeat(64)}`;
  const proposed = proposeExternalExecution(githubPullRequestWorkspace(), githubMergeInput({ sourceFingerprint }));
  assert.equal(proposed.execution.tool, "github_merge_pull_request");
  assert.equal(proposed.execution.authorizationMode, "human_approval");
  assert.equal(proposed.execution.sourceFingerprint, sourceFingerprint);
  assert.deepEqual(proposed.execution.arguments, { pr_number: 12, repository_full_name: "krharsh89/RuleRipple", expected_head_sha: "a".repeat(40), merge_method: "squash" });
  assert.ok(safeWorkspace(proposed.workspace));
  assert.throws(() => proposeExternalExecution(githubPullRequestWorkspace(), githubMergeInput({ idempotencyKey: "bad-sha", arguments: { repository_full_name: "krharsh89/RuleRipple", pr_number: 12, expected_head_sha: "abc" } })), /exact 40–64 character Git commit SHA/);
  assert.throws(() => proposeExternalExecution(githubWorkspace(), githubMergeInput({ idempotencyKey: "wrong-source-kind" })), /target must match/);
  assert.throws(() => proposeExternalExecution(githubPullRequestWorkspace(), githubMergeInput({ sourceFingerprint: "not-a-fingerprint" })), /SHA-256 fingerprint/);
  assert.throws(() => proposeExternalExecution(proposed.workspace, githubMergeInput({ sourceFingerprint, authorizedAmount: 999 })), /different external execution/);
  assert.throws(() => proposeExternalExecution(proposed.workspace, githubMergeInput({ sourceFingerprint: `sha256-${"c".repeat(64)}` })), /different external execution/);
});

test("eligible actions are policy-authorized automatically only when human approval is disabled", () => {
  const workspace = githubWorkspace();
  workspace.policy.governance = { ...governancePolicy(workspace.policy), requireApproval: false };
  workspace.versions.at(-1)!.snapshot = createSnapshot(workspace.policy, workspace.rules, workspace.cases);
  const proposed = proposeExternalExecution(workspace, githubExecutionInput({ idempotencyKey: "policy-authorized-action" }));
  assert.equal(proposed.execution.status, "approved");
  assert.equal(proposed.execution.authorizationMode, "policy_automatic");
  assert.equal(proposed.execution.approvedBy, "Active policy");
  assert.equal(proposed.workspace.ledger.at(-1)?.actor, "engine");
  assert.equal(proposed.workspace.ledger.at(-1)?.amount, 1000);
  assert.throws(() => approveExternalExecution(proposed.workspace, proposed.execution.id, "reviewer@example.com"), /Only pending external executions/);
  assert.ok(safeWorkspace(proposed.workspace));
});

test("external execution rejects ineligible, excessive, and unallowlisted actions", () => {
  const workspace = githubWorkspace();
  const boundaryWorkspace = structuredClone(workspace); boundaryWorkspace.cases = boundaryWorkspace.cases.map((item) => item.id === "C-01" ? { ...item, source: workspace.cases.find((candidate) => candidate.id === "C-02")!.source } : item);
  assert.throws(() => proposeExternalExecution(boundaryWorkspace, githubExecutionInput({ requestId: "C-01", idempotencyKey: "boundary" })), /Only eligible requests/);
  assert.throws(() => proposeExternalExecution(workspace, githubExecutionInput({ authorizedAmount: 23000, idempotencyKey: "too-large" })), /remaining simulated allocation/);
  assert.throws(() => proposeExternalExecution(workspace, githubExecutionInput({ idempotencyKey: "extra", arguments: { repository_full_name: "krharsh89/RuleRipple", issue_number: 42, labels: ["approved"], token: "secret" } })), /Unsupported external action arguments/);
  assert.throws(() => proposeExternalExecution(workspace, githubExecutionInput({ idempotencyKey: "bad-labels", arguments: { repository_full_name: "krharsh89/RuleRipple", issue_number: 42, labels: [] } })), /labels must contain/);
  assert.throws(() => proposeExternalExecution(workspace, githubExecutionInput({ actionId: "github.copilot.assign_issue", arguments: { owner: "krharsh89", repo: "RuleRipple", issue_number: 42 }, idempotencyKey: "unavailable-copilot" })), /historical evidence/);
});

test("human approval reserves capacity and stale policy inputs block approval", () => {
  const proposed = proposeExternalExecution(githubWorkspace(), githubExecutionInput()).workspace;
  const execution = proposed.executions[0];
  const approved = approveExternalExecution(proposed, execution.id, "reviewer@example.com");
  assert.equal(approved.executions[0].status, "approved");
  assert.equal(approved.executions[0].approvedBy, "reviewer@example.com");
  assert.equal(approved.ledger.find((event) => event.idempotencyKey === "github-rule-ripple-42:reserve")?.amount, 1000);
  assert.ok(safeWorkspace(approved));
  const stale = structuredClone(proposed); stale.rules[0].conditions[0].value = 24000;
  assert.throws(() => approveExternalExecution(stale, execution.id, "reviewer@example.com"), /Policy inputs changed/);
});

test("success commits the reservation and records an idempotent attributable receipt", () => {
  const proposed = proposeExternalExecution(githubWorkspace(), githubExecutionInput()).workspace;
  const approved = approveExternalExecution(proposed, proposed.executions[0].id, "reviewer@example.com");
  const receipt = { status: "succeeded" as const, externalReference: "github:krharsh89/RuleRipple#42:label:enhancement", resultUrl: "https://github.com/krharsh89/RuleRipple/issues/42", summary: "GitHub confirmed the approved label change." };
  const completed = recordExternalExecution(approved, approved.executions[0].id, receipt);
  assert.equal(completed.executions[0].status, "succeeded");
  assert.equal(resourceLedgerState(completed.policy.resources[0], completed.ledger).committed, 1000);
  assert.equal(recordExternalExecution(completed, completed.executions[0].id, receipt), completed);
  assert.throws(() => recordExternalExecution(completed, completed.executions[0].id, { ...receipt, summary: "Different result" }), /different receipt/);
  assert.ok(safeWorkspace(completed));
});

test("request-level reconciliation safely closes an existing external commitment", () => {
  const proposed = proposeExternalExecution(githubWorkspace(), githubExecutionInput()).workspace;
  const approved = approveExternalExecution(proposed, proposed.executions[0].id, "reviewer@example.com");
  const completed = recordExternalExecution(approved, approved.executions[0].id, { status: "succeeded", externalReference: "github:krharsh89/RuleRipple#42:label:enhancement", resultUrl: "https://github.com/krharsh89/RuleRipple/issues/42", summary: "GitHub confirmed the approved label change." });
  const reconciled = reconcileResourceUsage(completed, "C-02", "funding", 6000, "human", "request-total-usage");
  const state = resourceLedgerState(reconciled.policy.resources[0], reconciled.ledger);
  assert.equal(state.reserved, 0);
  assert.equal(state.committed, 0);
  assert.equal(state.consumed, 6000);
  assert.equal(reconciled.cases.find((item) => item.id === "C-02")?.actualUsage.funding, 6000);
});

test("provider usage reconciles against the exact successful external authorization", () => {
  const proposed = proposeExternalExecution(githubWorkspace(), githubExecutionInput()).workspace;
  const approved = approveExternalExecution(proposed, proposed.executions[0].id, "reviewer@example.com");
  const receipt = { status: "succeeded" as const, externalReference: "github:krharsh89/RuleRipple#42:label:enhancement", resultUrl: "https://github.com/krharsh89/RuleRipple/issues/42", summary: "GitHub confirmed the approved label change." };
  const immediate = recordExternalExecution(approved, approved.executions[0].id, { ...receipt, actualUsage: 600 });
  assert.equal(resourceLedgerState(immediate.policy.resources[0], immediate.ledger).consumed, 600);
  assert.equal(resourceLedgerState(immediate.policy.resources[0], immediate.ledger).committed, 0);
  assert.ok(safeWorkspace(immediate));
  const zeroUsage = recordExternalExecution(approved, approved.executions[0].id, { ...receipt, actualUsage: 0 });
  assert.equal(resourceLedgerState(zeroUsage.policy.resources[0], zeroUsage.ledger).available, zeroUsage.policy.resources[0].capacity - zeroUsage.policy.resources[0].reserve);
  assert.ok(safeWorkspace(zeroUsage));
  const recorded = recordExternalExecution(approved, approved.executions[0].id, receipt);
  assert.equal(resourceLedgerState(recorded.policy.resources[0], recorded.ledger).committed, 1000);
  const reconciled = recordExternalExecution(recorded, recorded.executions[0].id, { ...receipt, actualUsage: 600 });
  const state = resourceLedgerState(reconciled.policy.resources[0], reconciled.ledger);
  assert.equal(state.reserved, 0); assert.equal(state.committed, 0); assert.equal(state.consumed, 600);
  assert.equal(reconciled.executions[0].receipt?.actualUsage, 600);
  assert.equal(reconciled.cases.find((item) => item.id === "C-02")?.actualUsage.funding, 600);
  assert.ok(reconciled.ledger.some((event) => event.idempotencyKey === "github-rule-ripple-42:consume" && event.amount === 600));
  assert.ok(reconciled.ledger.some((event) => event.idempotencyKey === "github-rule-ripple-42:usage-release" && event.amount === 400));
  assert.equal(recordExternalExecution(reconciled, reconciled.executions[0].id, { ...receipt, actualUsage: 600 }), reconciled);
  assert.throws(() => recordExternalExecution(reconciled, reconciled.executions[0].id, { ...receipt, actualUsage: 500 }), /different receipt/);
  assert.throws(() => recordExternalExecution(approved, approved.executions[0].id, { ...receipt, actualUsage: 1001 }), /approved external authorization/);
  assert.throws(() => recordExternalExecution(approved, approved.executions[0].id, { ...receipt, status: "failed", actualUsage: 1 }), /only for a successful/);
  assert.ok(safeWorkspace(reconciled));
});

test("failure releases reserved capacity and rejection moves no capacity", () => {
  const first = proposeExternalExecution(githubWorkspace(), githubExecutionInput()).workspace;
  const rejected = rejectExternalExecution(first, first.executions[0].id);
  assert.equal(rejected.executions[0].status, "rejected");
  assert.equal(rejected.ledger.length, 0);
  const secondInput = githubExecutionInput({ idempotencyKey: "github-rule-ripple-retry", arguments: { repository_full_name: "krharsh89/RuleRipple", issue_number: 42, labels: ["enhancement"] } });
  const second = proposeExternalExecution(rejected, secondInput).workspace;
  const approved = approveExternalExecution(second, second.executions[1].id, "reviewer@example.com");
  assert.throws(() => recordExternalExecution(approved, second.executions[1].id, { status: "failed", externalReference: "github-error", resultUrl: "https://example.com/not-github", summary: "Permission denied." }), /github.com URL/);
  const failed = recordExternalExecution(approved, second.executions[1].id, { status: "failed", externalReference: "github-error:permission-denied", summary: "GitHub rejected the action; no external change was made." });
  assert.equal(failed.executions[1].status, "failed");
  assert.equal(resourceLedgerState(failed.policy.resources[0], failed.ledger).reserved, 0);
  assert.equal(resourceLedgerState(failed.policy.resources[0], failed.ledger).committed, 0);
  assert.ok(safeWorkspace(failed));
});

test("human revocation releases an approved action before invocation", () => {
  const proposed = proposeExternalExecution(githubWorkspace(), githubExecutionInput()).workspace;
  const approved = approveExternalExecution(proposed, proposed.executions[0].id, "reviewer@example.com");
  const cancelled = cancelExternalExecution(approved, approved.executions[0].id, "reviewer@example.com");
  assert.equal(cancelled.executions[0].status, "cancelled");
  assert.equal(cancelled.executions[0].cancelledBy, "reviewer@example.com");
  assert.equal(resourceLedgerState(cancelled.policy.resources[0], cancelled.ledger).reserved, 0);
  assert.equal(cancelled.ledger.at(-1)?.idempotencyKey, "github-rule-ripple-42:cancel");
  assert.throws(() => recordExternalExecution(cancelled, cancelled.executions[0].id, { status: "succeeded", externalReference: "late-result", summary: "Should be rejected." }), /authorized external execution/);
  assert.ok(safeWorkspace(cancelled));
});

test("decision traces distinguish eligibility failures from inactive modifiers", () => {
  const result = evaluateCase(defaultCases[0], defaultRules, defaultPolicy);
  assert.equal(result.trace.find((step) => step.ruleId === "R-03")?.effect, "failed");
  assert.equal(result.trace.find((step) => step.ruleId === "R-04")?.effect, "applied");
  const noBonus = evaluateCase(defaultCases[1], defaultRules, defaultPolicy).trace.find((step) => step.ruleId === "R-04");
  assert.equal(noBonus?.matched, false);
  assert.equal(noBonus?.effect, "not_applied");
});

test("ranks the closest failed threshold before passed thresholds", () => {
  const boundaryCases = findBoundaryCases(defaultCases, defaultRules, defaultPolicy);
  assert.equal(boundaryCases[0]?.caseId, "C-01");
  assert.equal(boundaryCases[0]?.nearestFailedThreshold?.ruleId, "R-03");
  const firstPassedOnly = boundaryCases.findIndex((item) => !item.nearestFailedThreshold);
  assert.ok(firstPassedOnly > 0);
  assert.ok(boundaryCases.slice(0, firstPassedOnly).every((item) => item.nearestFailedThreshold));
});

test("supports compound rules and transparent outcome overrides", () => {
  const override: PolicyRule = {
    id: "R-05", label: "Urgent and ready review", conditions: [
      { field: "urgency", operator: "eq", value: "high" },
      { field: "readiness", operator: "gte", value: 3 },
    ],
    match: "all", kind: "outcome", points: 0, result: "review", resourceId: null,
    amount: 0, priority: 50, enabled: true,
  };
  assert.equal(evaluateCase(defaultCases[3], [...defaultRules, override], defaultPolicy).outcome, "review");
});

test("a far failure is review even when another rule is exactly met", () => {
  const item: TestCase = {
    id: "C-X", name: "Synthetic far failure", values: { readiness: 3, communityReach: 100, urgency: "low" },
    demands: { funding: 100000 }, minimums: { funding: 100000 }, actualUsage: {},
  };
  const result = evaluateCase(item, defaultRules, defaultPolicy);
  assert.equal(result.outcome, "review");
  assert.equal(result.nearestFailedThreshold?.ruleId, "R-01");
});

test("strict numeric thresholds classify equality as a boundary failure", () => {
  const item = structuredClone(defaultCases[1]); item.values.readiness = 3;
  const strict = structuredClone(defaultRules); strict.find((rule) => rule.id === "R-02")!.conditions[0] = { field: "readiness", operator: "gt", value: 3 };
  const result = evaluateCase(item, strict.filter((rule) => rule.id !== "R-03"), defaultPolicy);
  assert.equal(result.outcome, "boundary");
  assert.equal(result.nearestFailedThreshold?.passed, false);
  assert.equal(result.nearestFailedThreshold?.distance, 0);
});

test("policy boundary settings control near-miss classification", () => {
  const narrow = structuredClone(defaultPolicy); narrow.boundary = { tolerance: 0.01, maximumFailedRules: 1 };
  assert.equal(evaluateCase(defaultCases[0], defaultRules, narrow).outcome, "review");
  assert.equal(findBoundaryCases(defaultCases, defaultRules, narrow).some((item) => item.caseId === "C-01"), false);

  const twoMisses = structuredClone(defaultCases[0]); twoMisses.values.readiness = 2;
  const oneFailureOnly = structuredClone(defaultPolicy); oneFailureOnly.boundary = { tolerance: 0.5, maximumFailedRules: 1 };
  const twoFailuresAllowed = structuredClone(defaultPolicy); twoFailuresAllowed.boundary = { tolerance: 0.5, maximumFailedRules: 2 };
  assert.equal(evaluateCase(twoMisses, defaultRules, oneFailureOnly).outcome, "review");
  assert.equal(evaluateCase(twoMisses, defaultRules, twoFailuresAllowed).outcome, "boundary");

  const disabled = structuredClone(defaultPolicy); disabled.boundary = { tolerance: 1, maximumFailedRules: 0 };
  assert.equal(evaluateCase(defaultCases[0], defaultRules, disabled).outcome, "review");
});

test("compound eligibility gates use the worst failed AND condition", () => {
  const compound: PolicyRule = {
    id: "R-X", label: "Ready and reachable", conditions: [
      { field: "readiness", operator: "gte", value: 3 },
      { field: "communityReach", operator: "gte", value: 100 },
    ], match: "all", kind: "threshold", points: 0, result: null, resourceId: null,
    amount: 0, priority: 0, enabled: true,
  };
  const item = structuredClone(defaultCases[0]); item.values.readiness = 2; item.values.communityReach = 99;
  const policy = structuredClone(defaultPolicy); policy.boundary = { tolerance: 0.25, maximumFailedRules: 1 };
  assert.equal(evaluateCase(item, [compound], policy).outcome, "review");
  policy.boundary.tolerance = 0.5;
  assert.equal(evaluateCase(item, [compound], policy).outcome, "boundary");

  const mixed = structuredClone(compound); mixed.conditions = [
    { field: "urgency", operator: "eq", value: "high" },
    { field: "communityReach", operator: "gte", value: 100 },
  ];
  item.values.urgency = "low";
  assert.equal(evaluateCase(item, [mixed], policy).outcome, "review");
  mixed.match = "any";
  assert.equal(evaluateCase(item, [mixed], policy).outcome, "boundary");
});

test("policy scoring settings control the deterministic base, floor, and ceiling", () => {
  const policy = structuredClone(defaultPolicy); policy.scoring = { base: 10, minimum: 5, maximum: 25 };
  assert.equal(evaluateCase(defaultCases[0], defaultRules, policy).score, 25);
  assert.equal(evaluateCase(defaultCases[1], defaultRules, policy).score, 10);
  const penalty = structuredClone(defaultRules); penalty[3].points = -20;
  assert.equal(evaluateCase(defaultCases[0], penalty, policy).score, 5);
});

test("policy audit reports lifecycle, duplicate, conflict, impossible-gate, and cap risks", () => {
  const policy = structuredClone(defaultPolicy); policy.governance = { owner: "Risk team", status: "retired", requireApproval: true, requireRationale: true };
  const duplicate = { ...structuredClone(defaultRules[3]), id: "R-05" };
  const condition = [{ field: "urgency", operator: "eq" as const, value: "high" }];
  const outcomeA: PolicyRule = { id: "R-06", label: "Approve urgent", conditions: condition, match: "all", kind: "outcome", points: 0, result: "eligible", resourceId: null, amount: 0, priority: 0, enabled: true };
  const outcomeB: PolicyRule = { ...outcomeA, id: "R-07", label: "Review urgent", result: "review" };
  const lower: PolicyRule = { id: "R-08", label: "Reach lower", conditions: [{ field: "communityReach", operator: "gte", value: 500 }], match: "all", kind: "threshold", points: 0, result: null, resourceId: null, amount: 0, priority: 0, enabled: true };
  const upper: PolicyRule = { ...lower, id: "R-09", label: "Reach upper", conditions: [{ field: "communityReach", operator: "lt", value: 400 }] };
  const cap: PolicyRule = { id: "R-10", label: "Urgent cap", conditions: condition, match: "all", kind: "cap", points: 0, result: null, resourceId: "funding", amount: 1000, priority: 0, enabled: true };
  const codes = new Set(auditPolicy(policy, [...defaultRules, duplicate, outcomeA, outcomeB, lower, upper, cap], defaultCases).map((issue) => issue.code));
  assert.deepEqual(codes, new Set(["RETIRED_POLICY", "DUPLICATE_RULE", "CONFLICTING_OUTCOME", "IMPOSSIBLE_THRESHOLD", "CAP_BELOW_MINIMUM"]));
});

test("policy audit detects reordered duplicate scoring rules as blocking", () => {
  const first: PolicyRule = { id: "R-X1", label: "Priority score", conditions: [{ field: "urgency", operator: "eq", value: "high" }, { field: "readiness", operator: "gte", value: 3 }], match: "all", kind: "score", points: 10, result: null, resourceId: null, amount: 0, priority: 0, enabled: true };
  const second: PolicyRule = { ...structuredClone(first), id: "R-X2", conditions: [...first.conditions].reverse() };
  const issue = auditPolicy(defaultPolicy, [first, second], defaultCases).find((item) => item.code === "DUPLICATE_RULE");
  assert.equal(issue?.severity, "error");
  assert.deepEqual(issue?.ruleIds, ["R-X1", "R-X2"]);
});

test("resource execution requires an active, effective, error-free policy", () => {
  const draft = structuredClone(defaultPolicy); draft.governance = { ...draft.governance!, status: "draft" };
  assert.equal(policyExecutionIssues(draft, defaultRules, defaultCases)[0]?.code, "DRAFT_POLICY");
  const future = structuredClone(defaultPolicy); future.governance = { ...future.governance!, effectiveFrom: "2999-01-01" };
  assert.equal(policyExecutionIssues(future, defaultRules, defaultCases)[0]?.code, "NOT_EFFECTIVE");
  assert.equal(policyExecutionIssues(defaultPolicy, defaultRules, defaultCases).length, 0);
});

test("allocates sequential capacity in published rank order", () => {
  const portfolio = allocateResources(defaultCases, defaultRules, defaultPolicy);
  assert.equal(portfolio.fundedCount, 5);
  assert.equal(portfolio.allocatedBudget, 98700);
  assert.equal(portfolio.remainingBudget, 1300);
  assert.equal(portfolio.allocations.find((item) => item.caseId === "C-04")?.rank, 1);
  assert.equal(portfolio.allocations.find((item) => item.caseId === "C-12")?.funded, true);
  assert.equal(portfolio.allocations.find((item) => item.caseId === "C-10")?.funded, false);
});

test("a request with no positive resource demand is never counted as funded", () => {
  const item = structuredClone(defaultCases[0]);
  item.demands.funding = 0;
  item.minimums.funding = 0;
  const portfolio = allocateResources([item], defaultRules, defaultPolicy);
  assert.equal(portfolio.fundedCount, 0);
  assert.equal(portfolio.allocations[0].funded, false);
  assert.equal(portfolio.allocations[0].fundedAmount, 0);
  const workspace = structuredClone(defaultWorkspace); workspace.cases = [item]; workspace.versions = [];
  assert.ok(safeWorkspace(workspace), "existing zero-demand data remains recoverable but is not funded");
});

test("enum ranking follows configured option order instead of alphabetical order", () => {
  const policy = structuredClone(defaultPolicy); policy.ranking = [{ source: "field", key: "urgency", direction: "desc" }];
  const ranked = allocateResources(defaultCases, defaultRules, policy).allocations.filter((item) => item.rank).sort((left, right) => left.rank! - right.rank!);
  assert.deepEqual(ranked.map((item) => item.caseId), ["C-04", "C-06", "C-09", "C-02", "C-10", "C-12"]);
});

test("rule validation rejects type-incompatible conditions and unsafe priorities", () => {
  const enumRule = structuredClone(defaultRules[0]); enumRule.conditions = [{ field: "urgency", operator: "gte", value: 1 }];
  assert.match(validateRule(enumRule, defaultPolicy).join(" "), /equality or membership/);
  const reversedBetween = structuredClone(defaultRules[0]); reversedBetween.conditions = [{ field: "readiness", operator: "between", value: [5, 1] }];
  assert.match(validateRule(reversedBetween, defaultPolicy).join(" "), /lower value/);
  const unsafePriority = structuredClone(defaultRules[0]); unsafePriority.priority = 1001;
  assert.match(validateRule(unsafePriority, defaultPolicy).join(" "), /priority/);
});

test("comparison reports rule, outcome, and resource allocation changes", () => {
  const candidate = structuredClone(defaultRules);
  candidate.find((rule) => rule.id === "R-03")!.conditions[0].value = 80;
  const comparison = compareRuleSets(defaultRules, candidate, defaultCases, defaultPolicy);
  assert.deepEqual(comparison.changedRules.map((item) => item.id), ["R-03"]);
  assert.ok(comparison.changedCases.some((item) => item.testCase.id === "C-01"));
  assert.ok(comparison.changedAllocations.some((item) => item.testCase.id === "C-01"));
});

test("full snapshot comparison replays baseline policy and requests", () => {
  const baseline = createSnapshot(defaultPolicy, defaultRules, defaultCases);
  const candidate = structuredClone(baseline); candidate.policy.resources[0].capacity = 50000; candidate.cases[0].demands.funding = 17000;
  const comparison = compareSimulationSnapshots(baseline, candidate);
  assert.equal(comparison.policyChanged, true);
  assert.deepEqual(comparison.changedRequests, ["C-01"]);
  assert.ok(comparison.changedAllocations.length > 0);
  assert.equal(comparison.beforePortfolio.resources[0].capacity, 100000);
  assert.equal(comparison.afterPortfolio.resources[0].capacity, 50000);
});

test("creates a durable policy impact report with version references and deltas", () => {
  const baseline = createSnapshot(defaultPolicy, defaultRules, defaultCases);
  const candidate = structuredClone(baseline); candidate.policy.resources[0].capacity = 50000;
  const report = createPolicyImpactReport({ id: "IR-01", label: "Capacity reduction", rationale: "Test scarcity.", actor: "human", approvedBy: "human", baseline, candidate, baselineVersionId: "V-03", candidateVersionId: "V-04", createdAt: "2026-08-30T00:00:00.000Z" });
  assert.equal(report.status, "approved");
  assert.equal(report.approvedBy, "human");
  assert.equal(report.policyChanged, true);
  assert.ok(report.allocationChanges > 0);
  assert.equal(report.resources[0].resourceId, "funding");
  const workspace = structuredClone(defaultWorkspace); workspace.versions.push({ id: "V-04", label: "Capacity reduction", rationale: "Test scarcity.", createdAt: report.createdAt, snapshot: candidate }); workspace.impactReports.push(report);
  assert.equal(safeWorkspace(workspace)?.impactReports[0].candidateVersionId, "V-04");
  const legacyReport = structuredClone(workspace); delete (legacyReport.impactReports[0] as Partial<PolicyImpactReport>).approvedBy; delete (legacyReport.impactReports[0] as Partial<PolicyImpactReport>).rankChanges;
  const migratedReport = safeWorkspace(legacyReport)?.impactReports[0];
  assert.equal(migratedReport?.approvedBy, "Human reviewer");
  assert.equal(migratedReport?.rankChanges, report.affectedCases.filter((item) => item.beforeRank !== item.afterRank).length);
  assert.equal(migratedReport?.allocationChanges, report.affectedCases.filter((item) => item.resources.some((resource) => Math.abs(resource.delta) > 0.000001)).length);
  workspace.impactReports[0].resources[0].delta = Number.NaN;
  assert.equal(safeWorkspace(workspace), null);
});

test("impact reports include changed requests even when their decision is unchanged", () => {
  const baseline = createSnapshot(defaultPolicy, defaultRules, defaultCases), candidate = structuredClone(baseline); candidate.cases[0].group = "Updated cohort";
  const report = createPolicyImpactReport({ id: "IR-01", label: "Request metadata", rationale: "Audit input provenance.", actor: "agent", baseline, candidate, candidateVersionId: "V-04", createdAt: "2026-08-30T00:00:00.000Z" });
  assert.equal(report.status, "applied");
  assert.equal(report.approvedBy, null);
  assert.deepEqual(report.changedRequests, ["C-01"]);
  assert.deepEqual(report.affectedCases.map((item) => item.caseId), ["C-01"]);
});

test("execution-only usage does not appear as a changed simulation request", () => {
  const baseline = createSnapshot(defaultPolicy, defaultRules, defaultCases); const candidate = structuredClone(baseline); candidate.cases[0].actualUsage.funding = 100;
  assert.deepEqual(compareSimulationSnapshots(baseline, candidate).changedRequests, []);
});

test("preset library covers money, credits, hours, inventory, slots, and quotas", () => {
  assert.equal(simulationPresets.length, 6);
  assert.deepEqual(new Set(simulationPresets.map((item) => item.category)), new Set(["Money", "AI credits", "Hours", "Inventory", "Slots", "Quota"]));
  for (const preset of simulationPresets) {
    assert.ok(safeWorkspace(preset.workspace), `${preset.id} should be persistable`);
    assert.equal(preset.title, preset.workspace.policy.name, `${preset.id} title should match its policy`);
    assert.equal(workspaceNeedsConfiguration(preset.workspace), true, `${preset.id} should require user configuration`);
    assert.equal(governancePolicy(preset.workspace.policy).owner, "Unassigned", `${preset.id} should not invent an owner`);
    const template = policyTemplateWorkspace(preset);
    const templatePortfolio = allocateResources(template.cases, template.rules, template.policy);
    assert.ok(safeWorkspace(template), `${preset.id} unconfigured schema should be persistable`);
    assert.equal(template.policy.resources.every((resource) => resource.capacity === 0 && resource.reserve === 0), true, `${preset.id} schema should not assert capacity`);
    assert.equal(template.policy.resources.every((resource) => resource.windowSeconds === undefined), true, `${preset.id} schema should not assert an operational rate window`);
    assert.equal(template.rules.length, 0, `${preset.id} schema should not assert rule thresholds`);
    assert.equal(template.cases.length, 0, `${preset.id} template should not preload request values`);
    assert.equal(template.versions.length, 0, `${preset.id} template should not preload versions`);
    assert.equal(template.activity.length, 0, `${preset.id} template should not preload activity`);
    assert.equal(template.ledger.length, 0, `${preset.id} template should not preload ledger events`);
    assert.equal(template.executions.length, 0, `${preset.id} template should not preload external actions`);
    assert.equal(templatePortfolio.allocatedBudget, 0, `${preset.id} template should not preload calculated assignments`);
    assert.equal(templatePortfolio.fundedCount, 0, `${preset.id} template should not preload funded results`);
  }
});

test("AI credit policy tells the intended governance and scarcity story", () => {
  const workspace = presetById("mcp-credit-governor")!.workspace;
  const portfolio = allocateResources(workspace.cases, workspace.rules, workspace.policy);
  const evaluations = new Map(portfolio.evaluations.map((item) => [item.caseId, item]));
  const allocations = new Map(portfolio.allocations.map((item) => [item.caseId, item]));

  assert.deepEqual(outcomeCounts(portfolio.evaluations), { eligible: 7, boundary: 1, review: 1 });
  assert.deepEqual(portfolio.resources[0], {
    resourceId: "credits", capacity: 100000, reserve: 10000, allocatable: 90000,
    allocated: 90000, remaining: 0, requested: 147000,
  });
  assert.deepEqual(
    portfolio.allocations.filter((item) => item.rank).sort((left, right) => left.rank! - right.rank!).map((item) => item.caseId),
    ["C-01", "C-02", "C-03", "C-04", "C-05", "C-06", "C-07"],
  );
  assert.equal(evaluations.get("C-01")?.score, 115);
  assert.equal(allocations.get("C-04")?.resources.credits.status, "partial");
  assert.equal(allocations.get("C-04")?.resources.credits.allocated, 30000);
  assert.equal(allocations.get("C-07")?.resources.credits.requested, 12000);
  assert.equal(allocations.get("C-07")?.resources.credits.rawRequested, 30000);
  assert.deepEqual(evaluations.get("C-08")?.failures, ["R-02"]);
  assert.equal(evaluations.get("C-08")?.outcome, "boundary");
  assert.deepEqual(evaluations.get("C-09")?.failures, ["R-01"]);
  assert.equal(evaluations.get("C-09")?.outcome, "review");
});

test("AI credit capacity counterfactual preserves reserve and minimum-useful work", () => {
  const workspace = structuredClone(presetById("mcp-credit-governor")!.workspace); workspace.policy.resources[0].capacity = 75000;
  const portfolio = allocateResources(workspace.cases, workspace.rules, workspace.policy); const allocations = new Map(portfolio.allocations.map((item) => [item.caseId, item.resources.credits]));
  assert.equal(portfolio.resources[0].allocatable, 65000);
  assert.equal(portfolio.resources[0].allocated, 60000);
  assert.equal(portfolio.resources[0].remaining, 5000);
  assert.equal(allocations.get("C-04")?.allocated, 0);
  assert.match(allocations.get("C-04")?.reason ?? "", /minimum useful/);
});

test("AI credit rule counterfactual ripples through outcome, rank, and allocation", () => {
  const baseline = structuredClone(presetById("mcp-credit-governor")!.workspace), workspace = structuredClone(baseline); workspace.rules.find((rule) => rule.id === "R-02")!.conditions[0].value = 6;
  const portfolio = allocateResources(workspace.cases, workspace.rules, workspace.policy); const allocations = new Map(portfolio.allocations.map((item) => [item.caseId, item])); const evaluations = new Map(portfolio.evaluations.map((item) => [item.caseId, item]));
  assert.equal(evaluations.get("C-08")?.outcome, "eligible");
  assert.equal(allocations.get("C-08")?.rank, 4);
  assert.equal(allocations.get("C-08")?.resources.credits.allocated, 8000);
  assert.equal(allocations.get("C-04")?.rank, 5);
  assert.equal(allocations.get("C-04")?.resources.credits.allocated, 22000);
  assert.equal(portfolio.resources[0].allocated, 90000);
  const comparison = compareSimulationSnapshots(createSnapshot(baseline.policy, baseline.rules, baseline.cases), createSnapshot(workspace.policy, workspace.rules, workspace.cases));
  assert.equal(comparison.changedCases.length, 1);
  assert.equal(comparison.changedRanks.length, 5);
  assert.deepEqual(comparison.changedAllocations.map((item) => item.testCase.id), ["C-04", "C-08"]);
  const report = createPolicyImpactReport({ id: "IR-01", label: "Readiness revision", rationale: "Readiness ripple.", actor: "human", approvedBy: "reviewer", baseline: createSnapshot(baseline.policy, baseline.rules, baseline.cases), candidate: createSnapshot(workspace.policy, workspace.rules, workspace.cases), baselineVersionId: baseline.versions.at(-1)?.id ?? null, candidateVersionId: "V-04", createdAt: "2026-08-30T00:00:00.000Z" });
  assert.equal(report.rankChanges, 5);
  assert.equal(report.allocationChanges, 2);
});

test("demand ranking uses capped effective demand", () => {
  const workspace = structuredClone(presetById("mcp-credit-governor")!.workspace); workspace.policy.ranking = [{ source: "demand", key: "credits", direction: "asc" }];
  const portfolio = allocateResources(workspace.cases, workspace.rules, workspace.policy);
  assert.equal(portfolio.allocations.find((item) => item.caseId === "C-07")?.rank, 1);
});

test("a cap below the declared minimum never creates an unusable allocation", () => {
  const workspace = structuredClone(presetById("mcp-credit-governor")!.workspace); const experiment = workspace.cases.find((item) => item.id === "C-07")!; experiment.minimums.credits = 15000;
  const allocation = allocateResources(workspace.cases, workspace.rules, workspace.policy).allocations.find((item) => item.caseId === "C-07")!.resources.credits;
  assert.equal(allocation.rawRequested, 30000);
  assert.equal(allocation.requested, 12000);
  assert.equal(allocation.minimum, 15000);
  assert.equal(allocation.allocated, 0);
  assert.match(allocation.reason, /cap is below/);
});

test("weighted fair, partial, and slot strategies exercise distinct behavior", () => {
  const healthcare = presetById("rural-healthcare")!.workspace;
  const healthPortfolio = allocateResources(healthcare.cases, healthcare.rules, healthcare.policy);
  assert.equal(healthPortfolio.resources[0].allocated, 296);
  assert.ok(healthPortfolio.allocations.some((item) => item.resources["clinic-hours"].status === "partial"));

  const supplies = presetById("emergency-supplies")!.workspace;
  const supplyPortfolio = allocateResources(supplies.cases, supplies.rules, supplies.policy);
  assert.equal(supplyPortfolio.resources[0].allocated, 850);
  assert.ok(supplyPortfolio.allocations.some((item) => item.resources["relief-kits"].status === "partial"));

  const inspections = presetById("school-inspections")!.workspace;
  const inspectionPortfolio = allocateResources(inspections.cases, inspections.rules, inspections.policy);
  assert.equal(inspectionPortfolio.fundedCount, 4);
  assert.deepEqual(inspectionPortfolio.allocations.filter((item) => item.funded).map((item) => item.caseId), ["C-01", "C-03", "C-04", "C-06"]);
});

test("share strategies never create unusable allocations below declared minimums", () => {
  const healthcare = structuredClone(presetById("rural-healthcare")!.workspace); healthcare.policy.resources[0].capacity = 50; healthcare.policy.resources[0].reserve = 0;
  const portfolio = allocateResources(healthcare.cases, healthcare.rules, healthcare.policy);
  for (const allocation of portfolio.allocations) {
    const resource = allocation.resources["clinic-hours"];
    assert.ok(resource.allocated === 0 || resource.allocated >= resource.minimum);
  }
  assert.equal(portfolio.resources[0].allocated, 50);
});

test("ledger reservations are capacity-safe and idempotent", () => {
  const workspace = structuredClone(presetById("mcp-credit-governor")!.workspace);
  const input = { idempotencyKey: "req-1", requestId: "C-01", resourceId: "credits", type: "reserve" as const, amount: 12000, actor: "agent" as const, note: "test" };
  const first = appendLedgerEvent(workspace, input);
  const duplicate = appendLedgerEvent(first.workspace, input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.workspace.ledger.length, 1);
  assert.throws(() => appendLedgerEvent(first.workspace, { ...input, amount: 11000 }), /different ledger operation/);
  assert.throws(() => appendLedgerEvent(first.workspace, { ...input, requestId: "C-02" }), /different ledger operation/);
  assert.equal(resourceLedgerState(workspace.policy.resources[0], first.workspace.ledger).available, 78000);
  assert.throws(() => appendLedgerEvent(first.workspace, { ...input, idempotencyKey: "too-much", amount: 80000 }), /remaining simulated allocation/);
  assert.throws(() => appendLedgerEvent(workspace, { ...input, requestId: "C-08", idempotencyKey: "ineligible", amount: 1 }), /no remaining policy allocation/);

  const retired = structuredClone(workspace); retired.policy.governance = { owner: "Operations", status: "retired", requireApproval: true, requireRationale: true };
  assert.throws(() => appendLedgerEvent(retired, { ...input, idempotencyKey: "retired" }), /active policy/);
});

test("releasing one request's commitment cannot consume another request's reservation", () => {
  const resource = presetById("mcp-credit-governor")!.workspace.policy.resources[0];
  const events = [
    { requestId: "a", type: "reserve", amount: 6000 },
    { requestId: "a", type: "commit", amount: 6000 },
    { requestId: "b", type: "reserve", amount: 2000 },
    { requestId: "a", type: "release", amount: 6000 },
  ].map((event, index) => ({ ...event, type: event.type as "reserve" | "commit" | "release", id: `L-${index}`, resourceId: resource.id, idempotencyKey: `mixed-${index}`, actor: "human" as const, note: "Accounting regression", createdAt: new Date().toISOString() }));
  const state = resourceLedgerState(resource, events);
  assert.equal(state.reserved, 2000);
  assert.equal(state.committed, 0);
  assert.equal(state.available, resource.capacity - resource.reserve - 2000);
});

test("whole-unit resources reject fractional policy, request, cap, and ledger values", () => {
  const workspace = structuredClone(presetById("mcp-credit-governor")!.workspace);
  const invalidRequest = structuredClone(workspace); invalidRequest.cases[0].demands.credits = 10.5;
  assert.equal(safeWorkspace(invalidRequest), null);
  const invalidPolicy = structuredClone(workspace); invalidPolicy.policy.resources[0].reserve = 0.5;
  assert.equal(safeWorkspace(invalidPolicy), null);
  const cap = structuredClone(workspace.rules.find((rule) => rule.kind === "cap")!); cap.amount = 1.5;
  assert.match(validateRule(cap, workspace.policy).join(" "), /whole credits/);
  assert.throws(() => appendLedgerEvent(workspace, { idempotencyKey: "fractional", requestId: "C-01", resourceId: "credits", type: "reserve", amount: 1.5, actor: "agent", note: "invalid" }), /whole credits/);
});

test("allocation defensively rounds malformed indivisible demand without consuming capacity", () => {
  const workspace = structuredClone(presetById("mcp-credit-governor")!.workspace); const item = workspace.cases.find((entry) => entry.id === "C-01")!;
  item.demands.credits = 0.5; item.minimums.credits = 0; workspace.cases = [item];
  const portfolio = allocateResources(workspace.cases, workspace.rules, workspace.policy);
  assert.equal(portfolio.allocations[0].resources.credits.allocated, 0);
  assert.equal(portfolio.resources[0].remaining, portfolio.resources[0].allocatable);
});

test("usage reconciliation consumes actual usage and releases the remainder", () => {
  const workspace = structuredClone(presetById("mcp-credit-governor")!.workspace);
  const reconciled = reconcileResourceUsage(workspace, "C-01", "credits", 9000, "agent", "run-1");
  assert.deepEqual(reconciled.ledger.map((item) => item.type), ["reserve", "commit", "consume", "release"]);
  const state = resourceLedgerState(workspace.policy.resources[0], reconciled.ledger);
  assert.equal(state.reserved, 0);
  assert.equal(state.committed, 0);
  assert.equal(state.consumed, 9000);
  assert.equal(state.available, 81000);
  assert.equal(reconciled.cases.find((item) => item.id === "C-01")?.actualUsage.credits, 9000);
  assert.equal(reconcileResourceUsage(reconciled, "C-01", "credits", 9000, "agent", "run-1").ledger.length, 4);
  assert.throws(() => reconcileResourceUsage(reconciled, "C-01", "credits", 8000, "agent", "run-1"), /different reconciliation/);
});

test("repeating an already-closed usage total with a new key does not add ledger noise", () => {
  const workspace = structuredClone(presetById("mcp-credit-governor")!.workspace);
  const reconciled = reconcileResourceUsage(workspace, "C-01", "credits", 9000, "agent", "run-1");
  assert.equal(reconcileResourceUsage(reconciled, "C-01", "credits", 9000, "human", "run-2"), reconciled);
});

test("rate-window usage reconciliation counts its newly recorded consumption", () => {
  const workspace = structuredClone(presetById("api-quota")!.workspace);
  const reconciled = reconcileResourceUsage(workspace, "C-01", "api-calls", 11000, "human", "rate-run-1");
  assert.deepEqual(reconciled.ledger.map((item) => item.type), ["reserve", "commit", "consume", "release"]);
  const state = resourceLedgerState(workspace.policy.resources[0], reconciled.ledger);
  assert.equal(state.consumed, 11000);
  assert.equal(state.reserved, 0);
  assert.equal(state.committed, 0);
  assert.equal(reconciled.cases.find((item) => item.id === "C-01")?.actualUsage["api-calls"], 11000);
});

test("retiring a policy blocks new reservations but still lets prior reservations close", () => {
  const workspace = structuredClone(presetById("mcp-credit-governor")!.workspace);
  const reserved = appendLedgerEvent(workspace, { idempotencyKey: "prior", requestId: "C-01", resourceId: "credits", type: "reserve", amount: 20000, actor: "agent", note: "before retirement" }).workspace;
  reserved.policy.governance = { ...reserved.policy.governance!, status: "retired" };
  const reconciled = reconcileResourceUsage(reserved, "C-01", "credits", 9000, "agent", "close-prior");
  assert.deepEqual(reconciled.ledger.map((item) => item.type), ["reserve", "commit", "consume", "release"]);
  assert.equal(resourceLedgerState(reserved.policy.resources[0], reconciled.ledger).consumed, 9000);
});

test("usage reconciliation closes a prior partial reservation without accounting drift", () => {
  const workspace = structuredClone(presetById("mcp-credit-governor")!.workspace);
  const partial = appendLedgerEvent(workspace, { idempotencyKey: "partial-reserve", requestId: "C-01", resourceId: "credits", type: "reserve", amount: 1000, actor: "agent", note: "partial" }).workspace;
  const reconciled = reconcileResourceUsage(partial, "C-01", "credits", 9000, "agent", "partial-run");
  const state = resourceLedgerState(workspace.policy.resources[0], reconciled.ledger);
  assert.equal(state.consumed, 9000);
  assert.equal(state.reserved, 0);
  assert.equal(state.committed, 0);
  assert.equal(reconciled.cases.find((item) => item.id === "C-01")?.actualUsage.credits, state.consumed);
});

test("rate-limit consumption expires after the configured rolling window", () => {
  const workspace = structuredClone(presetById("api-quota")!.workspace); const resource = workspace.policy.resources[0];
  const old = "2026-08-01T00:00:00.000Z";
  const events = [
    { id: "L-01", idempotencyKey: "old:r", requestId: "C-01", resourceId: resource.id, type: "reserve" as const, amount: 10000, createdAt: old, actor: "agent" as const, note: "old" },
    { id: "L-02", idempotencyKey: "old:c", requestId: "C-01", resourceId: resource.id, type: "commit" as const, amount: 10000, createdAt: old, actor: "agent" as const, note: "old" },
    { id: "L-03", idempotencyKey: "old:u", requestId: "C-01", resourceId: resource.id, type: "consume" as const, amount: 10000, createdAt: old, actor: "agent" as const, note: "old" },
  ];
  assert.equal(resourceLedgerState(resource, events, "2026-08-01T12:00:00.000Z").consumed, 10000);
  const reset = resourceLedgerState(resource, events, "2026-08-03T00:00:00.000Z");
  assert.equal(reset.consumed, 0);
  assert.equal(reset.available, resource.capacity - resource.reserve);
});

test("ledger retention never silently drops accounting or idempotency events", () => {
  let workspace = structuredClone(defaultWorkspace);
  for (let index = 0; index < 76; index += 1) {
    for (const [suffix, type] of [["r", "reserve"], ["c", "commit"], ["u", "consume"], ["f", "refund"]] as const) {
      workspace = appendLedgerEvent(workspace, { idempotencyKey: `cycle-${index}:${suffix}`, requestId: "C-04", resourceId: "funding", type, amount: 1, actor: "agent", note: "retention test" }).workspace;
    }
  }
  assert.equal(workspace.ledger.length, 304);
  assert.equal(workspace.ledger[0].idempotencyKey, "cycle-0:r");
  assert.ok(workspace.ledger.length < WORKSPACE_LIMITS.ledger);
  assert.equal(resourceLedgerState(workspace.policy.resources[0], workspace.ledger).available, 100000);
});

test("accepts valid cloud data and rejects malformed nested or unknown data", () => {
  assert.equal(safeWorkspace(structuredClone(defaultWorkspace))?.cases.length, 12);

  const legacySettings = structuredClone(defaultWorkspace);
  delete legacySettings.policy.boundary; delete legacySettings.policy.scoring; delete legacySettings.policy.governance;
  assert.equal(safeWorkspace(legacySettings)?.cases.length, 12);

  const malformedSettings = structuredClone(defaultWorkspace);
  malformedSettings.policy.boundary = { tolerance: 2, maximumFailedRules: 1 };
  assert.equal(safeWorkspace(malformedSettings), null);

  const duplicateHistoricalIdentity = structuredClone(defaultWorkspace);
  duplicateHistoricalIdentity.versions[0].snapshot.rules.push(structuredClone(duplicateHistoricalIdentity.versions[0].snapshot.rules[0]));
  assert.equal(safeWorkspace(duplicateHistoricalIdentity), null);

  const disabledBoundary = structuredClone(defaultWorkspace);
  disabledBoundary.policy.boundary = { tolerance: 1, maximumFailedRules: 0 };
  assert.equal(safeWorkspace(disabledBoundary)?.policy.boundary?.maximumFailedRules, 0);

  const badValue = structuredClone(defaultWorkspace);
  badValue.cases[0].values.readiness = "five";
  assert.equal(safeWorkspace(badValue), null);

  const unknownDemand = structuredClone(defaultWorkspace);
  unknownDemand.cases[0].demands.secretPool = 1;
  assert.equal(safeWorkspace(unknownDemand), null);

  const mismatchedSource = githubWorkspace();
  mismatchedSource.cases.find((item) => item.id === "C-02")!.source!.externalId = "krharsh89/RuleRipple#41";
  assert.equal(safeWorkspace(mismatchedSource), null);

  const malformedSnapshot = structuredClone(defaultWorkspace);
  malformedSnapshot.versions[0].snapshot.rules = [{ id: "broken" } as PolicyRule];
  assert.equal(safeWorkspace(malformedSnapshot), null);
});

test("normalizes legacy request fixture flags out of current and versioned data", () => {
  const legacy = structuredClone(defaultWorkspace);
  (legacy.cases[0] as TestCase & { fictional?: boolean }).fictional = true;
  (legacy.versions[0].snapshot.cases[0] as TestCase & { fictional?: boolean }).fictional = true;
  const restored = safeWorkspace(legacy)!;
  assert.equal("fictional" in restored.cases[0], false);
  assert.equal("fictional" in restored.versions[0].snapshot.cases[0], false);
});

test("rejects duplicate identities, invalid timestamps, and invalid ledger references", () => {
  const duplicateCase = structuredClone(defaultWorkspace);
  duplicateCase.cases[1].id = duplicateCase.cases[0].id.toLowerCase();
  assert.equal(safeWorkspace(duplicateCase), null);

  const duplicateName = structuredClone(defaultWorkspace);
  duplicateName.cases[1].name = ` ${duplicateName.cases[0].name.toUpperCase()} `;
  assert.equal(safeWorkspace(duplicateName), null);

  const invalidTime = structuredClone(defaultWorkspace);
  invalidTime.activity[0].createdAt = "not-a-time";
  assert.equal(safeWorkspace(invalidTime), null);

  const invalidLedger = structuredClone(defaultWorkspace);
  invalidLedger.ledger.push({ id: "L-01", idempotencyKey: "x", requestId: "missing", resourceId: "funding", type: "reserve", amount: 1, createdAt: new Date().toISOString(), actor: "agent", note: "bad reference" });
  assert.equal(safeWorkspace(invalidLedger), null);
});

test("rule IDs remain monotonic across version history", () => {
  const workspace = structuredClone(defaultWorkspace);
  workspace.rules = workspace.rules.filter((rule) => rule.id !== "R-04");
  assert.equal(nextRuleId(workspace), "R-05");
});

test("candidate comparison is type-sensitive and deterministic", () => {
  const reach = defaultRules.find((rule) => rule.id === "R-03")!;
  assert.equal(ruleValueDiffers(reach, 80), true);
  assert.equal(ruleValueDiffers(reach, 100), false);
  assert.equal(ruleValueDiffers(reach, "100"), true);
});
