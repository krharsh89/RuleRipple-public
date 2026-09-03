import assert from "node:assert/strict";
import test from "node:test";
import { reviewRequestBatch, validateBatchSelections, verifiedBudgetAmount, type BatchSelection } from "./operator-batch.ts";
import { assertClientOperatorState, assertCurrentAuthorization, assertPinnedIntake, executeClaimedAction, type ExecutionDependencies } from "./operator-execution-core.ts";
import { approveExternalExecution, appendLedgerEvent, cancelExternalExecution, createSnapshot, rejectExternalExecution, reconcileResourceUsage, resourceLedgerState, safeWorkspace } from "./domain.ts";
import { executionPolicyIsCurrent, executionRequiresBuiltIn } from "./execution-state.ts";
import { safeAppState, type AppState } from "./cloud-state.ts";
import type { GitHubPullRequest } from "./github-server.ts";

function workspace(capacity = 10000): AppState {
  return { undo: {}, data: { presetId: "custom", policy: { name: "Workflow budget", objective: "Fund approved work within the available envelope.", fields: [{ key: "priority", label: "Priority", type: "integer", min: 1, max: 5 }], outcomes: { eligible: "Eligible", boundary: "Boundary", review: "Review" }, resources: [{ id: "credits", label: "Credits", unit: "credits", capacity, reserve: 0, strategy: "partial", divisible: false }], primaryResourceId: "credits", ranking: [{ source: "field", key: "priority", direction: "desc" }], governance: { owner: "Operations", status: "active", requireApproval: true, requireRationale: true } }, rules: [], cases: [], versions: [], impactReports: [], activity: [], ledger: [], executions: [] } };
}
function pull(number: number, demand = 6000, minimum = demand): GitHubPullRequest {
  return { repositoryFullName: "org/config", number, title: `Workflow ${number}`, body: `## Policy intake\n- Priority: ${number === 1 ? 5 : 3}\n- Credits demand: ${demand}\n- Minimum useful allocation: ${minimum}`, state: "open", draft: false, mergeable: true, merged: false, mergedSha: null, headSha: String(number).repeat(40), baseSha: "a".repeat(40), headRef: `change-${number}`, baseRef: "main", htmlUrl: `https://github.com/org/config/pull/${number}`, author: "owner" };
}
const selections = [{ reference: "org/config#1" }, { reference: "org/config#2" }];
const inspect = async (selection: BatchSelection) => ({ pull: pull(Number(selection.reference.split("#")[1])) });

test("batch reads and validates all sources before preparing a shared-budget decision", async () => {
  const app = workspace(); let inspected = 0;
  const result = await reviewRequestBatch(app, selections, async (item) => { inspected++; assert.equal(app.data.executions.length, 0); return inspect(item); });
  assert.equal(inspected, 2);
  assert.deepEqual(result.batch.rows.map((row) => [row.rank, row.simulated, row.authorization]), [[1, 6000, 6000], [2, 0, 0]]);
  assert.equal(result.app.data.executions.length, 1);
  assert.equal(result.app.data.ledger.length, 0);
  assert.equal(app.data.cases.length, 0);
  assert.deepEqual(safeAppState(JSON.parse(JSON.stringify(result.app)))?.data.batches, [result.batch]);
});
test("reversed and duplicate selections preserve ranking without duplicate intake or actions", async () => {
  const forward = await reviewRequestBatch(workspace(), selections, inspect);
  const reverse = await reviewRequestBatch(workspace(), [...selections].reverse(), inspect);
  assert.deepEqual(forward.batch.rows, reverse.batch.rows);
  const repeated = await reviewRequestBatch(forward.app, [...selections, selections[0]], inspect);
  assert.equal(repeated.app.data.cases.length, 2);
  assert.equal(repeated.app.data.executions.length, 1);
  assert.equal(repeated.app.data.versions.length, 1);
});
test("invalid or unreadable member rejects the whole batch without changing workspace", async () => {
  const app = workspace(); const before = JSON.stringify(app);
  await assert.rejects(reviewRequestBatch(app, selections, async (item) => ({ pull: { ...(await inspect(item)).pull, ...(item.reference.endsWith("#2") ? { body: "missing intake" } : {}) } })), /Missing Policy intake/);
  assert.equal(JSON.stringify(app), before);
  await assert.rejects(reviewRequestBatch(app, selections, async () => { throw new Error("unavailable"); }), /unavailable/);
});
test("source readiness and canonical target are mandatory", async () => {
  for (const patch of [{ draft: true }, { mergeable: null }, { mergeable: false }, { state: "closed" }, { merged: true }, { repositoryFullName: "other/config" }]) {
    await assert.rejects(reviewRequestBatch(workspace(), [selections[0]], async () => ({ pull: { ...pull(1), ...patch } })));
  }
});
test("batch inputs are bounded and budget mapping cannot escape the repository", () => {
  for (const input of [[], Array(6).fill(selections[0]), [{ reference: "https://github.com.evil.test/a/b/pull/1" }], [{ reference: "org/config#0" }], [{ reference: "org/config#1", budget: { path: "../secret.json", pointer: "/credits", mode: "total" } }]]) assert.throws(() => validateBatchSelections(input));
  assert.equal(validateBatchSelections([{ reference: "https://github.com/Org/Config/pull/1" }, selections[0]]).length, 1);
});
test("configuration verification distinguishes total and incremental authorization", () => {
  const binding = { path: "workflows/a.json", pointer: "/budget/credits", mode: "increase" as const };
  assert.equal(verifiedBudgetAmount(binding, { budget: { credits: 2000 } }, { budget: { credits: 8000 } }), 6000);
  assert.equal(verifiedBudgetAmount({ ...binding, mode: "total" }, { budget: { credits: 2000 } }, { budget: { credits: 8000 } }), 8000);
  assert.equal(verifiedBudgetAmount(binding, null, { budget: { credits: 6000 } }), 6000);
  for (const after of [{ budget: { credits: "6000" } }, {}, { budget: { credits: 2000 } }, { budget: { credits: 1000 } }]) assert.throws(() => verifiedBudgetAmount(binding, { budget: { credits: 2000 } }, after));
});
test("configuration mismatch and partially funded configuration changes never produce an action", async () => {
  const budget = { path: "workflow.json", pointer: "/credits", mode: "increase" as const };
  const selected = [{ reference: "org/config#1", budget }];
  await assert.rejects(reviewRequestBatch(workspace(), selected, async () => ({ pull: pull(1), budget: { ...budget, baseSha: "a".repeat(40), amount: 7000 } })), /must both equal/);
  await assert.rejects(reviewRequestBatch(workspace(), selected, async () => ({ pull: pull(1, 6000, 1000), budget: { ...budget, baseSha: "a".repeat(40), amount: 6000 } })), /must both equal/);
  const result = await reviewRequestBatch(workspace(5000), selected, async () => ({ pull: pull(1), budget: { ...budget, baseSha: "a".repeat(40), amount: 6000 } }));
  assert.equal(result.app.data.executions.length, 0);
  assert.equal(result.batch.rows[0].authorization, 0);
});
test("existing commitments constrain funding even when the new simulation has room", async () => {
  const initial = await reviewRequestBatch(workspace(20000), [selections[1]], inspect);
  let data = approveExternalExecution(initial.app.data, initial.app.data.executions[0].id, "Owner");
  data = appendLedgerEvent(data, { idempotencyKey: "existing:commit", requestId: data.cases[0].id, resourceId: "credits", type: "commit", amount: 6000, actor: "human", note: "Existing work" }).workspace;
  data.policy.resources[0].capacity = 10000;
  const result = await reviewRequestBatch({ data, undo: {} }, [selections[0]], inspect);
  assert.equal(result.batch.rows[0].simulated, 6000);
  assert.equal(result.batch.rows[0].authorization, 0);
  assert.equal(result.batch.availableAtReview, 4000);
});
test("automatic authorization reserves only after whole-batch evaluation", async () => {
  const app = workspace(); app.data.policy.governance!.requireApproval = false;
  const result = await reviewRequestBatch(app, selections, inspect);
  assert.equal(result.app.data.executions[0].status, "approved");
  assert.equal(resourceLedgerState(result.app.data.policy.resources[0], result.app.data.ledger).reserved, 6000);
});

async function executionHarness(capacity = 10000) {
  const result = await reviewRequestBatch(workspace(capacity), selections, inspect);
  let stored = result.app, calls = 0, merged = false, conflicts = 0;
  const dependencies: ExecutionDependencies = {
    read: async () => structuredClone(stored),
    write: async (next, expected) => { if (JSON.stringify(expected) !== JSON.stringify(stored)) throw new Error("CLOUD_CONFLICT"); if (conflicts && next.data.executions.some((item) => item.status === "succeeded")) { conflicts--; throw new Error("CLOUD_CONFLICT"); } assert.ok(safeWorkspace(next.data)); stored = structuredClone(next); return structuredClone(stored); },
    inspect: async (execution) => ({ ...pull(Number(execution.arguments.pr_number)), merged, mergedSha: merged ? "f".repeat(40) : null }),
    validate: async (app, execution, current) => { assert.equal(current.headSha, execution.arguments.expected_head_sha); await assertPinnedIntake(app, execution, current); },
    merge: async (execution, validate) => { calls++; await validate(pull(Number(execution.arguments.pr_number))); merged = true; return { merged: true, sha: "f".repeat(40), message: "Merged", resultUrl: pull(1).htmlUrl }; },
  };
  return { id: result.app.data.executions[0].id, dependencies, get stored() { return stored; }, set stored(app: AppState) { stored = app; }, get calls() { return calls; }, set conflicts(count: number) { conflicts = count; }, set merged(value: boolean) { merged = value; } };
}
test("single-PR execution claims, reserves and commits exactly once", async () => {
  const harness = await executionHarness();
  await executeClaimedAction(harness.id, harness.dependencies);
  assert.equal(harness.calls, 1);
  assert.equal(harness.stored.data.executions[0].status, "succeeded");
  assert.equal(resourceLedgerState(harness.stored.data.policy.resources[0], harness.stored.data.ledger).committed, 6000);
  await executeClaimedAction(harness.id, harness.dependencies);
  assert.equal(harness.calls, 1);
});
test("simultaneous invocation sends only one external merge", async () => {
  const harness = await executionHarness();
  const results = await Promise.allSettled([executeClaimedAction(harness.id, harness.dependencies), executeClaimedAction(harness.id, harness.dependencies)]);
  assert.equal(harness.calls, 1);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
});
test("success receipt write conflicts do not repeat the merge", async () => {
  const harness = await executionHarness(); harness.conflicts = 2;
  await executeClaimedAction(harness.id, harness.dependencies);
  assert.equal(harness.calls, 1);
  assert.equal(harness.stored.data.executions[0].status, "succeeded");
});
test("previously approved actions still reject changed policy inputs", async () => {
  const harness = await executionHarness();
  harness.stored.data = approveExternalExecution(harness.stored.data, harness.id, "Owner");
  harness.stored.data.policy.resources[0].capacity += 1;
  await assert.rejects(executeClaimedAction(harness.id, harness.dependencies), /EXECUTION_POLICY_CHANGED/);
  assert.equal(harness.calls, 0);
});
test("changed source intake blocks before claiming or dispatch", async () => {
  const harness = await executionHarness();
  harness.dependencies.inspect = async () => pull(1, 7000);
  await assert.rejects(executeClaimedAction(harness.id, harness.dependencies), /GITHUB_POLICY_INTAKE_CHANGED/);
  assert.equal(harness.stored.data.ledger.length, 0);
  assert.equal(harness.calls, 0);
});
test("definitive rejection records failure and releases the reservation", async () => {
  const harness = await executionHarness();
  harness.dependencies.merge = async () => { throw new Error("GITHUB_HEAD_CHANGED"); };
  await assert.rejects(executeClaimedAction(harness.id, harness.dependencies), /GITHUB_HEAD_CHANGED/);
  assert.equal(harness.stored.data.executions[0].status, "failed");
  assert.equal(resourceLedgerState(harness.stored.data.policy.resources[0], harness.stored.data.ledger).reserved, 0);
});
test("uncertain outcomes retain their reservation and reconciliation cannot resend", async () => {
  const harness = await executionHarness(); let dispatches = 0;
  harness.dependencies.merge = async () => { dispatches++; throw new Error("GITHUB_UNAVAILABLE"); };
  await assert.rejects(executeClaimedAction(harness.id, harness.dependencies), /EXECUTION_RECONCILIATION_REQUIRED/);
  assert.equal(harness.stored.data.executions[0].attempt?.state, "uncertain");
  assert.equal(resourceLedgerState(harness.stored.data.policy.resources[0], harness.stored.data.ledger).reserved, 6000);
  assert.throws(() => cancelExternalExecution(harness.stored.data, harness.id, "Owner"), /reconciled/);
  await assert.rejects(executeClaimedAction(harness.id, harness.dependencies), /EXECUTION_RECONCILIATION_REQUIRED/);
  assert.equal(dispatches, 1);
  harness.merged = true;
  await executeClaimedAction(harness.id, harness.dependencies);
  assert.equal(dispatches, 1);
  assert.equal(harness.stored.data.executions[0].status, "succeeded");
});
test("expired claims allow only provider reconciliation and preserve workspace history", async () => {
  const harness = await executionHarness();
  harness.stored.data = approveExternalExecution(harness.stored.data, harness.id, "Owner");
  harness.stored.data.executions[0].attempt = { id: "old-claim", startedAt: "2020-01-01T00:00:00Z", state: "dispatching" };
  await assert.rejects(executeClaimedAction(harness.id, harness.dependencies), /EXECUTION_RECONCILIATION_REQUIRED/);
  assert.equal(harness.calls, 0);
  assert.equal(harness.stored.data.executions[0].attempt?.state, "uncertain");
  assert.equal(harness.stored.data.batches?.length, 1);
});
test("client cannot erase batch history or unlock an uncertain invocation", async () => {
  const harness = await executionHarness();
  let edited = structuredClone(harness.stored); edited.data.batches = [];
  assert.throws(() => assertClientOperatorState(harness.stored, edited), /SERVER_OWNED/);
  harness.stored.data = approveExternalExecution(harness.stored.data, harness.id, "Owner");
  harness.stored.data.executions[0].attempt = { id: "claim", startedAt: new Date().toISOString(), state: "uncertain" };
  edited = structuredClone(harness.stored); delete edited.data.executions[0].attempt;
  assert.throws(() => assertClientOperatorState(harness.stored, edited), /SERVER_OWNED/);
  assert.doesNotThrow(() => assertClientOperatorState(harness.stored, structuredClone(harness.stored)));
});
test("batch snapshot remains tied to the full portfolio, not just selected sources", async () => {
  const harness = await executionHarness();
  assert.doesNotThrow(() => assertCurrentAuthorization(harness.stored, harness.stored.data.executions[0]));
  harness.stored.data.cases[1].values.priority = 5;
  assert.throws(() => assertCurrentAuthorization(harness.stored, harness.stored.data.executions[0]), /POLICY_CHANGED/);
  assert.notDeepEqual(harness.stored.data.versions[0].snapshot, createSnapshot(harness.stored.data.policy, [], harness.stored.data.cases));
});

test("budget verification cannot silently reuse an earlier unverified authorization", async () => {
  const first = await reviewRequestBatch(workspace(), [selections[0]], inspect);
  const budget = { path: "workflow.json", pointer: "/credits", mode: "total" as const };
  await assert.rejects(reviewRequestBatch(first.app, [{ reference: "org/config#1", budget }], async () => ({ pull: pull(1), budget: { ...budget, baseSha: "a".repeat(40), amount: 6000 } })), /Resolve existing action/);
});
test("GitHub repository case normalization does not reject a canonical source", async () => {
  const result = await reviewRequestBatch(workspace(), [selections[0]], async () => ({ pull: { ...pull(1), htmlUrl: "https://github.com/Org/Config/pull/1" } }));
  assert.equal(result.app.data.executions.length, 1);
});
test("malformed saved batch history is rejected instead of throwing", async () => {
  const result = await reviewRequestBatch(workspace(), [selections[0]], inspect);
  assert.equal(safeWorkspace({ ...result.app.data, batches: [null] }), null);
  assert.equal(safeWorkspace({ ...result.app.data, batches: [{ ...result.batch, rows: [null] }] }), null);
});

test("re-review never presents an earlier policy approval as current funding", async () => {
  const result = await reviewRequestBatch(workspace(), selections, inspect);
  result.app.data.policy.resources[0].capacity = 5000;
  const before = JSON.stringify(result.app);
  await assert.rejects(reviewRequestBatch(result.app, selections, inspect), /Resolve.*EX-01/);
  assert.equal(JSON.stringify(result.app), before);
});

test("changed pinned source requires resolving its previous action before re-review", async () => {
  const result = await reviewRequestBatch(workspace(), [selections[0]], inspect);
  await assert.rejects(reviewRequestBatch(result.app, [selections[0]], async () => ({ pull: { ...pull(1), headSha: "b".repeat(40) } })), /Resolve.*EX-01/);
});

test("request inputs with ledger history cannot be overwritten by a batch", async () => {
  const result = await reviewRequestBatch(workspace(), [selections[0]], inspect);
  result.app.data = approveExternalExecution(result.app.data, result.app.data.executions[0].id, "Owner");
  await assert.rejects(reviewRequestBatch(result.app, [selections[0]], async () => ({ pull: pull(1, 7000) })), /ledger history/);
});

test("prepared execution details are immutable but human approval and rejection remain valid", async () => {
  const result = await reviewRequestBatch(workspace(), [selections[0]], inspect);
  const edited = structuredClone(result.app);
  edited.data.executions[0].authorizedAmount = 1000;
  assert.throws(() => assertClientOperatorState(result.app, edited), /SERVER_OWNED/);
  edited.data.executions = [];
  assert.throws(() => assertClientOperatorState(result.app, edited), /SERVER_OWNED/);
  assert.doesNotThrow(() => assertClientOperatorState(result.app, { ...result.app, data: approveExternalExecution(result.app.data, result.app.data.executions[0].id, "Owner") }));
  assert.doesNotThrow(() => assertClientOperatorState(result.app, { ...result.app, data: rejectExternalExecution(result.app.data, result.app.data.executions[0].id) }));
  const approved = { ...result.app, data: approveExternalExecution(result.app.data, result.app.data.executions[0].id, "Owner") };
  assert.doesNotThrow(() => assertClientOperatorState(approved, { ...approved, data: cancelExternalExecution(approved.data, approved.data.executions[0].id, "Owner") }));
});

test("budget-bound invocation independently checks authorization equals the whole change", async () => {
  const result = await reviewRequestBatch(workspace(), [selections[0]], inspect);
  const action = result.app.data.executions[0];
  action.budgetBinding = { path: "workflow.json", pointer: "/credits", mode: "total", amount: 6000, baseSha: "a".repeat(40) };
  action.authorizedAmount = 1000;
  await assert.rejects(assertPinnedIntake(result.app, action, pull(1)), /GITHUB_BUDGET_CHANGED/);
});

test("a pinned policy snapshot cannot be rewritten through the workspace API", async () => {
  const result = await reviewRequestBatch(workspace(), [selections[0]], inspect);
  const edited = structuredClone(result.app);
  edited.data.versions[0].snapshot.policy.resources[0].capacity += 1;
  assert.throws(() => assertClientOperatorState(result.app, edited), /SERVER_OWNED/);
});

test("request reconciliation cannot consume or release a not-yet-executed approval", async () => {
  const harness = await executionHarness();
  const data = approveExternalExecution(harness.stored.data, harness.id, "Owner");
  assert.throws(() => reconcileResourceUsage(data, data.executions[0].requestId, "credits", 0, "human", "too-soon"), /external action/);
});

test("legacy approved action with a missing reservation fails before GitHub dispatch", async () => {
  const harness = await executionHarness();
  let data = approveExternalExecution(harness.stored.data, harness.id, "Owner");
  data = appendLedgerEvent(data, { idempotencyKey: "old-release", requestId: data.executions[0].requestId, resourceId: "credits", type: "release", amount: 6000, actor: "human", note: "Prior release" }).workspace;
  harness.stored = { ...harness.stored, data };
  await assert.rejects(executeClaimedAction(harness.id, harness.dependencies), /EXECUTION_RESERVATION_CHANGED/);
  assert.equal(harness.calls, 0);
});

test("batch UI state marks changed policies stale and requires built-in dispatch", async () => {
  const result = await reviewRequestBatch(workspace(), [selections[0]], inspect);
  const action = result.app.data.executions[0];
  assert.equal(executionPolicyIsCurrent(result.app.data, action), true);
  assert.equal(executionRequiresBuiltIn(result.app.data, action), true);
  result.app.data.policy.resources[0].capacity++;
  assert.equal(executionPolicyIsCurrent(result.app.data, action), false);
});

test("two funded actions retain independent claims and receipts in sequential execution", async () => {
  const harness = await executionHarness(12000);
  const ids = harness.stored.data.executions.map((item) => item.id);
  assert.equal(ids.length, 2);
  await executeClaimedAction(ids[0], harness.dependencies);
  await executeClaimedAction(ids[1], harness.dependencies);
  assert.equal(harness.calls, 2);
  assert.deepEqual(harness.stored.data.executions.map((item) => item.status), ["succeeded", "succeeded"]);
  const ledger = resourceLedgerState(harness.stored.data.policy.resources[0], harness.stored.data.ledger);
  assert.equal(ledger.committed, 12000);
  assert.equal(ledger.reserved, 0);
  assert.equal(ledger.available, 0);
});

test("rejecting a stale proposal allows a clean current-portfolio review", async () => {
  const initial = await reviewRequestBatch(workspace(), selections, inspect);
  const old = initial.app.data.executions[0];
  initial.app.data.policy.resources[0].capacity = 12000;
  initial.app.data = rejectExternalExecution(initial.app.data, old.id);
  const current = await reviewRequestBatch(initial.app, selections, inspect);
  assert.equal(current.app.data.executions[0].status, "rejected");
  assert.deepEqual(current.batch.rows.map((row) => row.authorization), [6000, 6000]);
  assert.ok(current.batch.rows.every((row) => row.executionId !== old.id));
});
