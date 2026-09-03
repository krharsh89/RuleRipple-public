import { resourceLedgerState, type ExternalExecution, type LedgerEvent, type WorkspaceData } from "./domain.ts";

export function ledgerEventSequence(events: Pick<LedgerEvent, "type">[]): string {
  return events.length ? events.map((event) => event.type).join(" → ") : "No resource movement";
}

// Action receipts are historical evidence. A later request-level settlement
// must not be mistaken for usage reported by that action's provider.
export function externalExecutionAccounting(workspace: WorkspaceData, execution: ExternalExecution) {
  const resource = workspace.policy.resources.find((item) => item.id === execution.resourceId);
  if (!resource) throw new Error("Execution resource pool not found.");
  const requestEvents = workspace.ledger.filter((event) => event.requestId === execution.requestId && event.resourceId === execution.resourceId);
  const actionEvents = requestEvents.filter((event) => event.idempotencyKey.startsWith(`${execution.idempotencyKey}:`));
  const balances = (events: LedgerEvent[]) => {
    const { reserved, committed, consumed } = resourceLedgerState({ ...resource, capacity: Number.MAX_SAFE_INTEGER, reserve: 0 }, events);
    return { reserved, committed, consumed };
  };
  return { actionEvents: balances(actionEvents), requestTotals: balances(requestEvents) };
}
