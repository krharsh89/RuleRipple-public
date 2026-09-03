import { allocateWorkspaceResources, governancePolicy, planWorkspaceBudget, resourceLedgerState, type WorkspaceData } from "./domain.ts";

// This is an engine-owned snapshot, not model arithmetic or a page of requests.
export function reviewPortfolio(data: WorkspaceData) {
  const portfolio = allocateWorkspaceResources(data);
  const evaluations = new Map(portfolio.evaluations.map((item) => [item.caseId, item]));
  const allocations = new Map(portfolio.allocations.map((item) => [item.caseId, item]));
  const plans = new Map(data.policy.resources.map((resource) => [resource.id, planWorkspaceBudget(data, resource.id)]));
  return {
    evaluatedAt: new Date().toISOString(),
    policyName: data.policy.name,
    latestSavedVersion: data.versions.at(-1)?.id ?? null,
    governance: governancePolicy(data.policy),
    rules: data.rules.filter((rule) => rule.enabled),
    totalRequests: data.cases.length,
    evaluatedRequests: portfolio.evaluations.length,
    accountingNote: "Requested demand and simulated allocations are not usage or commitments. The ledger records reservations, commitments and reconciled consumption separately. Zero recorded consumption does not establish zero provider usage. Provider usage is unknown unless a receipt explicitly reports it. Additional authorizable amounts account for existing commitments and pending proposals; this review creates none.",
    resources: data.policy.resources.map((resource) => ({
      id: resource.id, label: resource.label, unit: resource.unit,
      requestedDemand: data.cases.reduce((sum, item) => sum + (item.demands[resource.id] ?? 0), 0),
      simulatedAllocation: portfolio.resources.find((item) => item.resourceId === resource.id)?.allocated ?? 0,
      ledger: resourceLedgerState(resource, data.ledger),
    })),
    requests: data.cases.map((request) => {
      const evaluation = evaluations.get(request.id)!;
      const allocation = allocations.get(request.id)!;
      return {
        id: request.id, name: request.name, outcome: evaluation.outcome, score: evaluation.score, rank: allocation.rank,
        failures: evaluation.failures,
        nearestThreshold: evaluation.nearestFailedThreshold ?? evaluation.nearestThreshold,
        resources: data.policy.resources.map((resource) => {
          const row = plans.get(resource.id)!.rows.find((item) => item.request.id === request.id)!;
          return {
            id: resource.id, requestedDemand: request.demands[resource.id] ?? 0,
            minimum: allocation.resources[resource.id].minimum,
            simulatedAllocation: row.simulated, additionalAuthorizable: row.amount,
            reserved: row.held.reserved, committed: row.held.committed, recordedConsumption: row.held.consumed,
            pendingProposal: row.pending,
          };
        }),
      };
    }),
    executionUsage: data.executions.map((item) => ({
      executionId: item.id, requestId: item.requestId, resourceId: item.resourceId, status: item.status,
      receiptReportedUsage: item.receipt?.actualUsage ?? null,
    })),
  };
}

export type PortfolioReview = ReturnType<typeof reviewPortfolio>;
