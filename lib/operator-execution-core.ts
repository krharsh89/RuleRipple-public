import { approveExternalExecution, compareSimulationSnapshots, createSnapshot, policyExecutionIssues, recordExternalExecution, resourceLedgerState, safeWorkspace, WORKSPACE_LIMITS, type ExternalExecution } from "./domain.ts";
import { nextActivityId } from "./history.ts";
import type { AppState } from "./cloud-state.ts";
import type { GitHubMergeReceipt, GitHubPullRequest } from "./github-server.ts";
import { canonicalJson, requestInputFingerprint, requestInputFromPullRequest } from "./operator-intake.ts";

export class ExecutionError extends Error {}
export function assertApprovedReservation(app: AppState, execution: ExternalExecution) {
  if (execution.status !== "approved") return;
  const resource = app.data.policy.resources.find((item) => item.id === execution.resourceId);
  if (!resource) throw new ExecutionError("EXECUTION_RESERVATION_CHANGED");
  const events = app.data.ledger.filter((event) => event.requestId === execution.requestId && event.resourceId === execution.resourceId);
  const state = resourceLedgerState(resource, events);
  const required = app.data.executions.filter((item) => item.status === "approved" && item.requestId === execution.requestId && item.resourceId === execution.resourceId).reduce((sum, item) => sum + item.authorizedAmount, 0);
  const exact = resourceLedgerState(resource, events.filter((event) => event.idempotencyKey.startsWith(`${execution.idempotencyKey}:`)));
  if (state.reserved + 0.000001 < required || exact.reserved + 0.000001 < execution.authorizedAmount) throw new ExecutionError("EXECUTION_RESERVATION_CHANGED");
}

export function assertCurrentAuthorization(app: AppState, execution: ExternalExecution) {
  const version = app.data.versions.find((item) => item.id === execution.policyVersionId);
  if (!version) throw new ExecutionError("EXECUTION_POLICY_CHANGED");
  const comparison = compareSimulationSnapshots(version.snapshot, createSnapshot(app.data.policy, app.data.rules, app.data.cases));
  if (comparison.policyChanged || comparison.changedRules.length || comparison.changedRequests.length || policyExecutionIssues(app.data.policy, app.data.rules, app.data.cases).length) throw new ExecutionError("EXECUTION_POLICY_CHANGED");
}

export async function assertPinnedIntake(app: AppState, execution: ExternalExecution, pull: GitHubPullRequest) {
  if (!execution.sourceFingerprint) throw new ExecutionError("EXECUTION_SOURCE_NOT_PINNED");
  const parsed = requestInputFromPullRequest(pull, app.data);
  if (!parsed.requestInput || parsed.errors.length || await requestInputFingerprint(parsed.requestInput) !== execution.sourceFingerprint) throw new ExecutionError("GITHUB_POLICY_INTAKE_CHANGED");
  if (execution.budgetBinding) {
    const amount = execution.budgetBinding.amount;
    const demands = parsed.requestInput.demands as Record<string, number>;
    const minimums = parsed.requestInput.minimums as Record<string, number>;
    if (execution.authorizedAmount !== amount || demands[execution.resourceId] !== amount || minimums[execution.resourceId] !== amount) throw new ExecutionError("GITHUB_BUDGET_CHANGED");
  }
}

export function assertClientOperatorState(before: AppState | null, after: AppState) {
  if (canonicalJson(before?.data.batches ?? []) !== canonicalJson(after.data.batches ?? [])) throw new ExecutionError("OPERATOR_HISTORY_SERVER_OWNED");
  for (const execution of after.data.executions) {
    const prior = before?.data.executions.find((item) => item.id === execution.id);
    if (canonicalJson(execution.attempt) !== canonicalJson(prior?.attempt) || canonicalJson(execution.budgetBinding) !== canonicalJson(prior?.budgetBinding)) throw new ExecutionError("OPERATOR_EXECUTION_SERVER_OWNED");
  }
  for (const execution of before?.data.executions ?? []) {
    if (execution.sourceFingerprint) {
      const next = after.data.executions.find((item) => item.id === execution.id);
      const pinned = before?.data.versions.find((version) => version.id === execution.policyVersionId);
      if (canonicalJson(pinned) !== canonicalJson(after.data.versions.find((version) => version.id === execution.policyVersionId))) throw new ExecutionError("OPERATOR_EXECUTION_SERVER_OWNED");
      // Approval, rejection and revocation may change lifecycle fields, never
      // the inspected target, resource amount, source or policy being approved.
      const proposal = (item: ExternalExecution) => {
        const { status, approvedBy, approvedAt, cancelledBy, cancelledAt, receipt, attempt, ...pinned } = item;
        void status; void approvedBy; void approvedAt; void cancelledBy; void cancelledAt; void receipt; void attempt;
        return pinned;
      };
      if (!next || canonicalJson(proposal(next)) !== canonicalJson(proposal(execution))) throw new ExecutionError("OPERATOR_EXECUTION_SERVER_OWNED");
      const serverManaged = execution.budgetBinding || before?.data.batches?.some((batch) => batch.rows.some((row) => row.executionId === execution.id));
      if (serverManaged && (canonicalJson(next.receipt) !== canonicalJson(execution.receipt) || next.status !== execution.status && !(
        execution.status === "pending_approval" && ["approved", "rejected"].includes(next.status) || execution.status === "approved" && next.status === "cancelled"
      ))) throw new ExecutionError("OPERATOR_EXECUTION_SERVER_OWNED");
      if (next.status === "approved") assertApprovedReservation(after, next);
    }
    if (!execution.attempt && !execution.budgetBinding) continue;
    const next = after.data.executions.find((item) => item.id === execution.id);
    if (!next || execution.attempt && canonicalJson(next) !== canonicalJson(execution)) throw new ExecutionError("OPERATOR_EXECUTION_SERVER_OWNED");
    const events = (app: AppState) => app.data.ledger.filter((event) => event.idempotencyKey.startsWith(`${execution.idempotencyKey}:`));
    if (execution.attempt && canonicalJson(events(before!)) !== canonicalJson(events(after))) throw new ExecutionError("OPERATOR_EXECUTION_SERVER_OWNED");
    if (execution.attempt && execution.status === "approved") {
      const requestEvents = (app: AppState) => app.data.ledger.filter((event) => event.requestId === execution.requestId && event.resourceId === execution.resourceId);
      if (canonicalJson(requestEvents(before!)) !== canonicalJson(requestEvents(after))) throw new ExecutionError("EXECUTION_RECONCILIATION_REQUIRED");
    }
  }
}

export interface ExecutionDependencies {
  read: () => Promise<AppState>;
  write: (next: AppState, expected: AppState) => Promise<AppState>;
  inspect: (execution: ExternalExecution) => Promise<GitHubPullRequest>;
  validate: (app: AppState, execution: ExternalExecution, pull: GitHubPullRequest) => Promise<void>;
  merge: (execution: ExternalExecution, validate: (pull: GitHubPullRequest) => Promise<void>) => Promise<GitHubMergeReceipt>;
  now?: () => number;
}

// An expired claim permits reconciliation, never another merge dispatch.
export async function executeClaimedAction(id: string, deps: ExecutionDependencies) {
  let app = await deps.read();
  const existing = app.data.executions.find((item) => item.id === id);
  if (!existing) throw new ExecutionError("EXTERNAL_EXECUTION_NOT_FOUND");
  if (existing.status === "succeeded" && existing.receipt) return { app, execution: existing, duplicate: true };
  if (!["pending_approval", "approved"].includes(existing.status) || existing.actionId !== "github.pull_request.merge") throw new ExecutionError("EXTERNAL_EXECUTION_NOT_RUNNABLE");
  const now = deps.now ?? Date.now;
  if (existing.attempt?.state === "dispatching" && now() - Date.parse(existing.attempt.startedAt) < 90_000) throw new ExecutionError("EXECUTION_IN_PROGRESS");
  let receipt: GitHubMergeReceipt;
  if (existing.attempt) {
    const pull = await deps.inspect(existing);
    if (pull.headSha !== existing.arguments.expected_head_sha || !pull.merged || !pull.mergedSha) {
      await updateLatest(deps, id, (current) => { const action = current.data.executions.find((item) => item.id === id)!; action.attempt = { ...action.attempt!, state: "uncertain", message: "GitHub has not confirmed a merge. Reservation retained; no repeat invocation permitted." }; return current; });
      throw new ExecutionError("EXECUTION_RECONCILIATION_REQUIRED");
    }
    receipt = { merged: true, sha: pull.mergedSha, resultUrl: pull.htmlUrl, message: "GitHub confirmed the authorized head is merged." };
  } else {
    assertCurrentAuthorization(app, existing);
    assertApprovedReservation(app, existing);
    const preflight = await deps.inspect(existing);
    await deps.validate(app, existing, preflight);
    const next = structuredClone(app);
    if (existing.status === "pending_approval") next.data = approveExternalExecution(next.data, id, "Workspace owner");
    next.data.executions.find((item) => item.id === id)!.attempt = { id: crypto.randomUUID(), startedAt: new Date(now()).toISOString(), state: "dispatching" };
    app = await deps.write(next, app);
    try {
      receipt = await deps.merge(existing, async (pull) => {
        const current = await deps.read();
        const claimed = current.data.executions.find((item) => item.id === id);
        if (claimed?.attempt?.id !== app.data.executions.find((item) => item.id === id)?.attempt?.id) throw new ExecutionError("EXECUTION_CLAIM_CHANGED");
        assertApprovedReservation(current, claimed!);
        assertCurrentAuthorization(current, existing);
        await deps.validate(current, existing, pull);
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "EXECUTION_OUTCOME_UNKNOWN";
      const definitive = ["GITHUB_CONNECTION_EXPIRED", "GITHUB_PERMISSION_DENIED", "GITHUB_TARGET_NOT_FOUND", "GITHUB_PULL_REQUEST_NOT_MERGEABLE", "GITHUB_HEAD_CHANGED", "GITHUB_MERGE_REJECTED", "GITHUB_PULL_REQUEST_NOT_OPEN", "GITHUB_MERGEABILITY_PENDING", "EXECUTION_POLICY_CHANGED", "GITHUB_POLICY_INTAKE_CHANGED", "GITHUB_BUDGET_CHANGED", "GITHUB_PULL_REQUEST_ALREADY_MERGED"].includes(code);
      await updateLatest(deps, id, (current) => {
        if (definitive) current.data = recordExternalExecution(current.data, id, { status: "failed", externalReference: `github:rejected:${id}`, summary: "GitHub execution was rejected or failed validation. No merge was confirmed; the reservation was released." });
        else current.data.executions.find((item) => item.id === id)!.attempt = { ...current.data.executions.find((item) => item.id === id)!.attempt!, state: "uncertain", message: "Outcome not confirmed. Reservation retained; reconcile with GitHub before any further action." };
        return current;
      });
      throw new ExecutionError(definitive ? code : "EXECUTION_RECONCILIATION_REQUIRED");
    }
  }
  const externalReference = `github:${existing.arguments.repository_full_name}#${existing.arguments.pr_number}:merge:${receipt.sha}`;
  const saved = await updateLatest(deps, id, (current) => {
    const execution = current.data.executions.find((item) => item.id === id)!;
    if (execution.status === "succeeded" && execution.receipt?.externalReference === externalReference) return current;
    current.data = recordExternalExecution(current.data, id, { status: "succeeded", externalReference, resultUrl: receipt.resultUrl, summary: `GitHub confirmed pull request #${existing.arguments.pr_number} merged at commit ${receipt.sha}.` });
    current.data.activity = [{ id: nextActivityId(current.data.activity, current.undo), actor: "engine" as const, action: "GitHub merge confirmed", detail: `${id}: GitHub confirmed commit ${receipt.sha}; authorization committed and receipt retained.`, createdAt: new Date().toISOString(), undoable: false }, ...current.data.activity].slice(0, WORKSPACE_LIMITS.activity);
    return current;
  });
  return { app: saved, execution: saved.data.executions.find((item) => item.id === id)!, duplicate: Boolean(existing.attempt) };
}

async function updateLatest(deps: ExecutionDependencies, id: string, change: (app: AppState) => AppState): Promise<AppState> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await deps.read();
    if (!current.data.executions.some((item) => item.id === id)) throw new ExecutionError("EXTERNAL_EXECUTION_RECEIPT_CONFLICT");
    const next = change(structuredClone(current));
    if (!safeWorkspace(next.data)) throw new ExecutionError("INVALID_COMPLETED_WORKSPACE");
    try { return await deps.write(next, current); }
    catch (error) { if (!(error instanceof Error) || error.message !== "CLOUD_CONFLICT" || attempt === 3) throw error; }
  }
  throw new ExecutionError("EXTERNAL_EXECUTION_RECEIPT_CONFLICT");
}
