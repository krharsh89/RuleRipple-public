import type { FieldDefinition, Policy, RankingCriterion, ResourcePool, WorkspaceData } from "./domain.ts";

export interface SimulationPreset {
  id: string;
  title: string;
  category: string;
  description: string;
  capability: string;
  workspace: WorkspaceData;
}

export const UNCONFIGURED_PRESET_ID = "unconfigured";

export function workspaceNeedsConfiguration(workspace: WorkspaceData): boolean {
  return workspace.presetId === UNCONFIGURED_PRESET_ID || workspace.presetId.startsWith("schema:");
}

export function unconfiguredWorkspace(): WorkspaceData {
  const policy: Policy = {
    name: "Untitled policy",
    objective: "Define the decision this policy should govern.",
    outcomes: { eligible: "Eligible", boundary: "Boundary", review: "Review" },
    fields: [{ key: "input", label: "Decision input", type: "number" }],
    resources: [{ id: "resource", label: "Primary resource", unit: "units", capacity: 0, reserve: 0, strategy: "priority_first_fit", divisible: true }],
    primaryResourceId: "resource",
    ranking: [{ source: "score", direction: "desc" }],
    boundary: { tolerance: 0, maximumFailedRules: 0 },
    scoring: { base: 0, minimum: 0, maximum: 0 },
    governance: { owner: "Unassigned", status: "draft", requireApproval: true, requireRationale: true },
  };
  return { policy, rules: [], cases: [], versions: [], impactReports: [], activity: [], ledger: [], executions: [], presetId: UNCONFIGURED_PRESET_ID };
}

function schemaWorkspace(id: string, policy: Policy): WorkspaceData {
  return {
    policy,
    rules: [],
    cases: [],
    versions: [],
    impactReports: [],
    activity: [],
    ledger: [],
    executions: [],
    presetId: `schema:${id}`,
  };
}

function schemaPolicy(
  name: string,
  objective: string,
  fields: FieldDefinition[],
  resource: Pick<ResourcePool, "id" | "label" | "unit" | "strategy" | "divisible">,
  ranking: RankingCriterion[],
): Policy {
  return {
    name,
    objective,
    fields,
    resources: [{ ...resource, capacity: 0, reserve: 0 }],
    primaryResourceId: resource.id,
    ranking,
    outcomes: { eligible: "Eligible", boundary: "Boundary", review: "Review" },
    boundary: { tolerance: 0, maximumFailedRules: 0 },
    scoring: { base: 0, minimum: 0, maximum: 0 },
    governance: { owner: "Unassigned", status: "draft", requireApproval: true, requireRationale: true },
  };
}

function template(id: string, category: string, description: string, capability: string, policy: Policy): SimulationPreset {
  return { id, title: policy.name, category, description, capability, workspace: schemaWorkspace(id, policy) };
}

export const simulationPresets: SimulationPreset[] = [
  template(
    "disaster-resilience",
    "Money",
    "Structure funding decisions for resilience requests.",
    "All-or-nothing funding",
    schemaPolicy(
      "Community Resilience Fund",
      "Rank and allocate a configured resilience fund across community requests.",
      [
        { key: "readiness", label: "Readiness score", type: "integer", min: 1, max: 5 },
        { key: "communityReach", label: "Community reach", type: "integer", unit: "people", min: 0 },
        { key: "urgency", label: "Urgency", type: "enum", options: ["low", "medium", "high"] },
      ],
      { id: "funding", label: "Program funding", unit: "USD", strategy: "priority_first_fit", divisible: false },
      [{ source: "score", direction: "desc" }, { source: "field", key: "communityReach", direction: "desc" }, { source: "demand", key: "funding", direction: "asc" }],
    ),
  ),
  template(
    "mcp-credit-governor",
    "AI credits",
    "Structure credit allocation across MCP workflows.",
    "Priority + partial allocation + ledger",
    schemaPolicy(
      "AI Operations Credit Governor",
      "Allocate a configured credit envelope across competing MCP workflows while protecting operational headroom and enforcing execution readiness.",
      [
        { key: "criticality", label: "Business criticality", type: "integer", min: 1, max: 5 },
        { key: "readiness", label: "Execution readiness", type: "integer", min: 1, max: 10 },
        { key: "urgency", label: "Urgency", type: "enum", options: ["low", "medium", "high"] },
        { key: "workflowType", label: "Workflow type", type: "enum", options: ["security", "compliance", "customer", "revenue", "operations", "experiment"] },
        { key: "approved", label: "Execution approved", type: "boolean" },
      ],
      { id: "credits", label: "Agent credits", unit: "credits", strategy: "partial", divisible: false },
      [{ source: "score", direction: "desc" }, { source: "field", key: "criticality", direction: "desc" }, { source: "demand", key: "credits", direction: "asc" }],
    ),
  ),
  template(
    "rural-healthcare",
    "Hours",
    "Structure shared-capacity decisions for mobile care.",
    "Divisible capacity",
    schemaPolicy(
      "Rural Healthcare Capacity",
      "Allocate mobile-clinic hours across communities using weighted fair shares and transparent access thresholds.",
      [
        { key: "patients", label: "Patients reached", type: "integer", min: 0 },
        { key: "distance", label: "Distance to hospital", type: "number", unit: "km", min: 0 },
        { key: "readiness", label: "Operational readiness", type: "integer", min: 1, max: 5 },
        { key: "urgency", label: "Clinical urgency", type: "enum", options: ["low", "medium", "high"] },
      ],
      { id: "clinic-hours", label: "Mobile clinic capacity", unit: "hours", strategy: "weighted_fair", divisible: true },
      [{ source: "score", direction: "desc" }, { source: "field", key: "patients", direction: "desc" }],
    ),
  ),
  template(
    "emergency-supplies",
    "Inventory",
    "Structure partial allocation of essential inventory.",
    "Partial allocation",
    schemaPolicy(
      "Emergency Supply Allocation",
      "Partially allocate relief inventory across affected areas while honoring minimum useful deliveries.",
      [
        { key: "affected", label: "People affected", type: "integer", min: 0 },
        { key: "vulnerability", label: "Vulnerability score", type: "integer", min: 1, max: 5 },
        { key: "access", label: "Access difficulty", type: "integer", min: 1, max: 5 },
        { key: "urgency", label: "Urgency", type: "enum", options: ["low", "medium", "high"] },
      ],
      { id: "relief-kits", label: "Relief inventory", unit: "kits", strategy: "partial", divisible: false },
      [{ source: "score", direction: "desc" }, { source: "field", key: "affected", direction: "desc" }],
    ),
  ),
  template(
    "school-inspections",
    "Slots",
    "Structure deterministic assignment of inspection appointments.",
    "Discrete slots",
    schemaPolicy(
      "School Safety Inspections",
      "Assign a finite number of inspection slots to schools using urgency and student exposure.",
      [
        { key: "students", label: "Students exposed", type: "integer", min: 0 },
        { key: "buildingAge", label: "Building age", type: "integer", unit: "years", min: 0 },
        { key: "incidents", label: "Recent incidents", type: "integer", min: 0 },
        { key: "urgency", label: "Urgency", type: "enum", options: ["low", "medium", "high"] },
      ],
      { id: "inspection-slots", label: "Inspection capacity", unit: "slots", strategy: "slot", divisible: false },
      [{ source: "score", direction: "desc" }, { source: "field", key: "students", direction: "desc" }],
    ),
  ),
  template(
    "api-quota",
    "Quota",
    "Structure API-call allocation within an explicit rate window.",
    "Rate-window quota",
    schemaPolicy(
      "Team API Quota",
      "Allocate an API-call quota across teams within an explicitly configured rate window while preserving operational headroom.",
      [
        { key: "businessValue", label: "Business value", type: "integer", min: 1, max: 5 },
        { key: "reliability", label: "Reliability score", type: "integer", min: 1, max: 5 },
        { key: "production", label: "Production workload", type: "boolean" },
        { key: "urgency", label: "Urgency", type: "enum", options: ["low", "medium", "high"] },
      ],
      { id: "api-calls", label: "API call quota", unit: "calls", strategy: "rate_limit", divisible: false },
      [{ source: "score", direction: "desc" }, { source: "field", key: "businessValue", direction: "desc" }, { source: "demand", key: "api-calls", direction: "asc" }],
    ),
  ),
];

export function policyTemplateWorkspace(preset: SimulationPreset): WorkspaceData {
  return structuredClone(preset.workspace);
}

export function presetById(id: string): SimulationPreset | undefined {
  return simulationPresets.find((preset) => preset.id === id);
}
