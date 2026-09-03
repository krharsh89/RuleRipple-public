export const workspaceSections = [
  { id: "inbox", group: "Daily work", label: "Request inbox", title: "More requests. One shared budget.", description: "Review incoming requests together, understand who can be funded, and authorize the next step." },
  { id: "executions", group: "Daily work", label: "External actions", title: "Actions & receipts", description: "Review exact actions, follow execution, and inspect the evidence returned by each connected system." },
  { id: "ledger", group: "Daily work", label: "Budget ledger", title: "Where the budget stands", description: "Track reservations, committed authorization, recorded consumption, and available capacity separately." },
  { id: "canvas", group: "Policy & analysis", label: "Policy & rules", title: "Policy & rules", description: "Define eligibility, priority, resource limits, and when human approval is required." },
  { id: "cases", group: "Policy & analysis", label: "All requests", title: "All requests", description: "Inspect and manage the inputs behind every decision, including requests received from agents." },
  { id: "impact", group: "Policy & analysis", label: "What-if scenarios", title: "See the effect before changing policy", description: "Preview a rule or resource change across the entire portfolio. Apply only after reviewing its impact." },
  { id: "versions", group: "Policy & analysis", label: "Versions & reports", title: "Compare decisions over time", description: "Compare saved policy versions and retain the rationale behind each change." },
  { id: "operator", group: "Workspace", label: "Connections", title: "Connect your workflow", description: "Set up agent intake and external actions. The policy assistant stays available beside every page." },
  { id: "activity", group: "Workspace", label: "Activity log", title: "Workspace activity", description: "Trace changes, decisions, and execution events back to their source." },
] as const;

export type WorkspaceTab = typeof workspaceSections[number]["id"];
export const navigationGroups = ["Daily work", "Policy & analysis", "Workspace"] as const;

export function assistantSuggestion(tab: WorkspaceTab): string {
  if (tab === "ledger") return "Review all saved requests. Explain requested demand, committed authorization, available balance, and whether measured usage is known. Do not change anything.";
  if (tab === "canvas" || tab === "impact") return "Summarize the active policy, evaluate all current requests, and identify requests near an eligibility threshold. Do not change anything.";
  return "Evaluate the entire active portfolio. Explain which requests can receive budget and why others are waiting. Distinguish proposals, authorizations, and measured usage. Do not change anything.";
}
