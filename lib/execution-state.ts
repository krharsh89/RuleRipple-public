import { compareSimulationSnapshots, createSnapshot, policyExecutionIssues, type ExternalExecution, type WorkspaceData } from "./domain.ts";

export function executionPolicyIsCurrent(data: WorkspaceData, execution: ExternalExecution) {
  const pinned = data.versions.find((version) => version.id === execution.policyVersionId);
  if (!pinned || policyExecutionIssues(data.policy, data.rules, data.cases).length) return false;
  const changes = compareSimulationSnapshots(pinned.snapshot, createSnapshot(data.policy, data.rules, data.cases));
  return !changes.policyChanged && !changes.changedRules.length && !changes.changedRequests.length;
}

export function executionRequiresBuiltIn(data: WorkspaceData, execution: ExternalExecution) {
  return Boolean(execution.attempt || execution.budgetBinding || data.batches?.some((batch) => batch.rows.some((row) => row.executionId === execution.id)));
}
