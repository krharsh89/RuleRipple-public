import {
  createSnapshot,
  type FieldDefinition,
  type FieldValue,
  type Policy,
  type PolicyRule,
  type ResourcePool,
  type TestCase,
  type WorkspaceData,
} from "./domain.ts";

// Populated policy portfolios belong only to automated engine tests. The
// production template catalog is intentionally schema-only.

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

export function policyTemplateWorkspace(preset: SimulationPreset): WorkspaceData {
  const policy = structuredClone(preset.workspace.policy);
  policy.resources = policy.resources.map((resource) => {
    const structure = { ...resource };
    delete structure.windowSeconds;
    return { ...structure, capacity: 0, reserve: 0 };
  });
  policy.boundary = { tolerance: 0, maximumFailedRules: 0 };
  policy.scoring = { base: 0, minimum: 0, maximum: 0 };
  policy.governance = { owner: "Unassigned", status: "draft", requireApproval: true, requireRationale: true };
  const rules: PolicyRule[] = [];
  const cases: TestCase[] = [];
  return {
    policy,
    rules,
    cases,
    versions: [],
    impactReports: [],
    activity: [],
    ledger: [],
    executions: [],
    presetId: `schema:${preset.id}`,
  };
}

const now = "2026-08-29T08:00:00.000Z";

function request(
  id: string,
  name: string,
  values: Record<string, FieldValue>,
  demands: Record<string, number>,
  minimums: Record<string, number> = demands,
  group?: string,
): TestCase {
  return { id, name, values, demands, minimums, actualUsage: {}, group };
}

function rule(id: string, label: string, field: string, operator: PolicyRule["conditions"][number]["operator"], value: FieldValue | FieldValue[], kind: PolicyRule["kind"] = "threshold", points = 0): PolicyRule {
  return { id, label, conditions: [{ field, operator, value }], match: "all", kind, points, result: null, resourceId: null, amount: 0, priority: 0, enabled: true };
}

function makeWorkspace(id: string, policy: Policy, rules: PolicyRule[], cases: TestCase[]): WorkspaceData {
  return {
    policy,
    rules,
    cases,
    versions: [
      { id: "V-01", label: "Baseline", rationale: "Initial policy scenario baseline.", createdAt: now, snapshot: createSnapshot(policy, rules, cases) },
    ],
    impactReports: [],
    activity: [{ id: "A-01", actor: "engine", action: `${cases.length} scenario requests ready`, detail: `${policy.name} loaded from the simulation library.`, createdAt: now, undoable: false }],
    ledger: [],
    executions: [],
    presetId: id,
  };
}

function policy(
  name: string,
  objective: string,
  fields: FieldDefinition[],
  resource: ResourcePool,
  ranking: Policy["ranking"],
  owner: string,
): Policy {
  return {
    name,
    objective,
    fields,
    resources: [resource],
    primaryResourceId: resource.id,
    ranking,
    outcomes: { eligible: "Eligible", boundary: "Boundary", review: "Review" },
    boundary: { tolerance: 0.25, maximumFailedRules: 1 },
    scoring: { base: 50, minimum: 0, maximum: 1000 },
    governance: { owner, status: "active", requireApproval: true, requireRationale: true },
  };
}

const harborPolicy = policy(
  "Harbor Community Resilience Fund",
  "Allocate a configured resilience fund transparently across neighborhood resilience requests.",
  [
    { key: "readiness", label: "Readiness score", type: "integer", min: 1, max: 5 },
    { key: "communityReach", label: "Community reach", type: "integer", unit: "people", min: 0 },
    { key: "urgency", label: "Urgency", type: "enum", options: ["low", "medium", "high"] },
  ],
  { id: "funding", label: "Program funding", unit: "USD", capacity: 100000, reserve: 0, strategy: "priority_first_fit", divisible: false },
  [{ source: "score", direction: "desc" }, { source: "field", key: "communityReach", direction: "desc" }, { source: "demand", key: "funding", direction: "asc" }],
  "Harbor Resilience Committee",
);
const harborRules: PolicyRule[] = [
  rule("R-01", "Funding request cap", "demand:funding", "lte", 25000),
  rule("R-02", "Project readiness", "readiness", "gte", 3),
  rule("R-03", "Community reach", "communityReach", "gte", 100),
  rule("R-04", "Urgency bonus", "urgency", "eq", "high", "score", 20),
];
const harborCases = [
  request("C-01", "Harbor Flood Shelter", { readiness: 4, communityReach: 98, urgency: "high" }, { funding: 18500 }),
  request("C-02", "Northside Cooling Hub", { readiness: 4, communityReach: 240, urgency: "medium" }, { funding: 22000 }),
  request("C-03", "Market Street Solar", { readiness: 5, communityReach: 175, urgency: "low" }, { funding: 31000 }),
  request("C-04", "Riverside Radio Network", { readiness: 3, communityReach: 430, urgency: "high" }, { funding: 12400 }),
  request("C-05", "East Ward Water Store", { readiness: 3, communityReach: 80, urgency: "high" }, { funding: 24800 }),
  request("C-06", "Juniper Street Clinic", { readiness: 5, communityReach: 310, urgency: "high" }, { funding: 20500 }),
  request("C-07", "Old Port Battery Bank", { readiness: 4, communityReach: 190, urgency: "medium" }, { funding: 26900 }),
  request("C-08", "Hillview Evacuation Map", { readiness: 2, communityReach: 520, urgency: "medium" }, { funding: 8200 }),
  request("C-09", "Canal District Food Hub", { readiness: 4, communityReach: 145, urgency: "high" }, { funding: 24000 }),
  request("C-10", "Beacon Youth Responders", { readiness: 3, communityReach: 110, urgency: "low" }, { funding: 15300 }),
  request("C-11", "South Pier Pump Repair", { readiness: 5, communityReach: 85, urgency: "high" }, { funding: 25000 }),
  request("C-12", "Meadow Block Tree Canopy", { readiness: 4, communityReach: 205, urgency: "low" }, { funding: 19800 }),
];

export const defaultPolicy = structuredClone(harborPolicy);
export const defaultRules = structuredClone(harborRules);
export const defaultCases = structuredClone(harborCases);
const harborV1Rules = structuredClone(defaultRules); harborV1Rules.find((item) => item.id === "R-03")!.conditions[0].value = 150;
const harborV2Rules = structuredClone(defaultRules); harborV2Rules.find((item) => item.id === "R-03")!.conditions[0].value = 120;
export const defaultWorkspace: WorkspaceData = {
  policy: structuredClone(defaultPolicy),
  rules: structuredClone(defaultRules),
  cases: structuredClone(defaultCases),
  versions: [
    { id: "V-01", label: "Version 1", rationale: "Initial conservative reach threshold.", createdAt: "2026-08-27T09:00:00.000Z", snapshot: createSnapshot(defaultPolicy, harborV1Rules, defaultCases) },
    { id: "V-02", label: "Version 2", rationale: "Lowered reach threshold after reviewing smaller projects.", createdAt: "2026-08-27T09:20:00.000Z", snapshot: createSnapshot(defaultPolicy, harborV2Rules, defaultCases) },
    { id: "V-03", label: "Version 3", rationale: "Current baseline for boundary analysis.", createdAt: "2026-08-27T09:40:00.000Z", snapshot: createSnapshot(defaultPolicy, defaultRules, defaultCases) },
  ],
  impactReports: [],
  activity: [
    { id: "A-03", actor: "engine", action: "12 cases evaluated", detail: "Deterministic multi-resource policy run completed.", createdAt: "2026-08-27T09:42:00.000Z", undoable: false },
    { id: "A-02", actor: "agent", action: "Urgency bonus added", detail: "Added R-04 with a 20 point bonus.", createdAt: "2026-08-27T09:40:00.000Z", undoable: false },
    { id: "A-01", actor: "human", action: "Version 3 saved", detail: "Approved current baseline.", createdAt: "2026-08-27T09:39:00.000Z", undoable: false },
  ],
  ledger: [],
  executions: [],
  presetId: "disaster-resilience",
};

const mcpPolicy = policy(
  "AI Operations Credit Governor",
  "Allocate an explicitly configured credit envelope across competing MCP workflows while protecting operational headroom and enforcing execution readiness.",
  [
    { key: "criticality", label: "Business criticality", type: "integer", min: 1, max: 5 },
    { key: "readiness", label: "Execution readiness", type: "integer", min: 1, max: 10 },
    { key: "urgency", label: "Urgency", type: "enum", options: ["low", "medium", "high"] },
    { key: "workflowType", label: "Workflow type", type: "enum", options: ["security", "compliance", "customer", "revenue", "operations", "experiment"] },
    { key: "approved", label: "Execution approved", type: "boolean" },
  ],
  { id: "credits", label: "Agent credits", unit: "credits", capacity: 100000, reserve: 10000, strategy: "partial", divisible: false },
  [{ source: "score", direction: "desc" }, { source: "field", key: "criticality", direction: "desc" }, { source: "demand", key: "credits", direction: "asc" }],
  "AI Operations Council",
);
const mcpRules: PolicyRule[] = [
  rule("R-01", "Execution must be approved", "approved", "eq", true),
  rule("R-02", "Minimum execution readiness", "readiness", "gte", 7),
  rule("R-03", "Critical workflow bonus", "criticality", "gte", 4, "score", 30),
  rule("R-04", "Urgent workflow bonus", "urgency", "eq", "high", "score", 20),
  rule("R-05", "Compliance deadline bonus", "workflowType", "eq", "compliance", "score", 15),
  { ...rule("R-06", "Experiment credit cap", "workflowType", "eq", "experiment", "cap"), resourceId: "credits", amount: 12000 },
];
const mcpCases = [
  request("C-01", "Regulatory evidence sweep", { criticality: 4, readiness: 8, urgency: "high", workflowType: "compliance", approved: true }, { credits: 20000 }, { credits: 12000 }, "Risk & compliance"),
  request("C-02", "Security incident containment", { criticality: 5, readiness: 9, urgency: "high", workflowType: "security", approved: true }, { credits: 18000 }, { credits: 12000 }, "Security operations"),
  request("C-03", "Fraud queue surge", { criticality: 5, readiness: 8, urgency: "high", workflowType: "operations", approved: true }, { credits: 22000 }, { credits: 14000 }, "Trust operations"),
  request("C-04", "Customer support backlog", { criticality: 4, readiness: 9, urgency: "high", workflowType: "customer", approved: true }, { credits: 35000 }, { credits: 20000 }, "Customer experience"),
  request("C-05", "Knowledge index refresh", { criticality: 3, readiness: 7, urgency: "low", workflowType: "operations", approved: true }, { credits: 16000 }, { credits: 8000 }, "Platform operations"),
  request("C-06", "Sales account enrichment", { criticality: 3, readiness: 8, urgency: "medium", workflowType: "revenue", approved: true }, { credits: 24000 }, { credits: 10000 }, "Revenue operations"),
  request("C-07", "Research benchmark experiment", { criticality: 2, readiness: 8, urgency: "low", workflowType: "experiment", approved: true }, { credits: 30000 }, { credits: 6000 }, "AI research"),
  request("C-08", "Executive briefing agent", { criticality: 4, readiness: 6, urgency: "high", workflowType: "operations", approved: true }, { credits: 8000 }, { credits: 8000 }, "Executive office"),
  request("C-09", "Shadow agent prototype", { criticality: 5, readiness: 9, urgency: "high", workflowType: "experiment", approved: false }, { credits: 10000 }, { credits: 5000 }, "Unapproved sandbox"),
];

const healthPolicy = policy(
  "Rural Healthcare Capacity",
  "Allocate mobile-clinic hours across communities using weighted fair shares and transparent access thresholds.",
  [
    { key: "patients", label: "Patients reached", type: "integer", min: 0 },
    { key: "distance", label: "Distance to hospital", type: "number", unit: "km", min: 0 },
    { key: "readiness", label: "Operational readiness", type: "integer", min: 1, max: 5 },
    { key: "urgency", label: "Clinical urgency", type: "enum", options: ["low", "medium", "high"] },
  ],
  { id: "clinic-hours", label: "Mobile clinic capacity", unit: "hours", capacity: 320, reserve: 24, strategy: "weighted_fair", divisible: true },
  [{ source: "score", direction: "desc" }, { source: "field", key: "patients", direction: "desc" }],
  "Regional Health Capacity Board",
);
const healthRules = [
  rule("R-01", "Minimum readiness", "readiness", "gte", 2),
  rule("R-02", "Minimum patient reach", "patients", "gte", 40),
  rule("R-03", "Remote community bonus", "distance", "gte", 40, "score", 20),
  rule("R-04", "Clinical urgency bonus", "urgency", "eq", "high", "score", 25),
];
const healthCases = [
  request("C-01", "Kotra Mobile Clinic", { patients: 180, distance: 82, readiness: 4, urgency: "high" }, { "clinic-hours": 96 }, { "clinic-hours": 48 }),
  request("C-02", "Bhilwara Maternal Camp", { patients: 120, distance: 55, readiness: 5, urgency: "high" }, { "clinic-hours": 72 }, { "clinic-hours": 36 }),
  request("C-03", "Dausa Screening Route", { patients: 210, distance: 34, readiness: 3, urgency: "medium" }, { "clinic-hours": 80 }, { "clinic-hours": 32 }),
  request("C-04", "Barmer Telehealth Van", { patients: 95, distance: 120, readiness: 2, urgency: "medium" }, { "clinic-hours": 88 }, { "clinic-hours": 40 }),
  request("C-05", "Ajmer Wellness Fair", { patients: 35, distance: 12, readiness: 5, urgency: "low" }, { "clinic-hours": 40 }, { "clinic-hours": 20 }),
];

const supplyPolicy = policy(
  "Emergency Supply Allocation",
  "Partially allocate relief kits across affected districts while honoring minimum viable deliveries.",
  [
    { key: "affected", label: "People affected", type: "integer", min: 0 },
    { key: "vulnerability", label: "Vulnerability score", type: "integer", min: 1, max: 5 },
    { key: "access", label: "Access difficulty", type: "integer", min: 1, max: 5 },
    { key: "urgency", label: "Urgency", type: "enum", options: ["low", "medium", "high"] },
  ],
  { id: "relief-kits", label: "Relief inventory", unit: "kits", capacity: 1000, reserve: 150, strategy: "partial", divisible: false },
  [{ source: "score", direction: "desc" }, { source: "field", key: "affected", direction: "desc" }],
  "Emergency Logistics Command",
);
const supplyRules = [
  rule("R-01", "Minimum affected population", "affected", "gte", 100),
  rule("R-02", "Vulnerability bonus", "vulnerability", "gte", 4, "score", 25),
  rule("R-03", "Urgency bonus", "urgency", "eq", "high", "score", 20),
  rule("R-04", "Hard-access bonus", "access", "gte", 4, "score", 10),
];
const supplyCases = [
  request("C-01", "River Delta Ward", { affected: 900, vulnerability: 5, access: 4, urgency: "high" }, { "relief-kits": 380 }, { "relief-kits": 180 }),
  request("C-02", "Hill Block Cluster", { affected: 520, vulnerability: 4, access: 5, urgency: "high" }, { "relief-kits": 300 }, { "relief-kits": 150 }),
  request("C-03", "East Market Zone", { affected: 430, vulnerability: 3, access: 2, urgency: "medium" }, { "relief-kits": 250 }, { "relief-kits": 100 }),
  request("C-04", "Coastal Fishing Hamlet", { affected: 260, vulnerability: 5, access: 5, urgency: "medium" }, { "relief-kits": 220 }, { "relief-kits": 100 }),
  request("C-05", "Central Office Reserve", { affected: 50, vulnerability: 2, access: 1, urgency: "low" }, { "relief-kits": 150 }, { "relief-kits": 50 }),
];

const inspectionPolicy = policy(
  "School Safety Inspections",
  "Assign a finite number of inspection slots to schools with the greatest urgency and student exposure.",
  [
    { key: "students", label: "Students exposed", type: "integer", min: 0 },
    { key: "buildingAge", label: "Building age", type: "integer", unit: "years", min: 0 },
    { key: "incidents", label: "Recent incidents", type: "integer", min: 0 },
    { key: "urgency", label: "Urgency", type: "enum", options: ["low", "medium", "high"] },
  ],
  { id: "inspection-slots", label: "Inspection capacity", unit: "slots", capacity: 4, reserve: 0, strategy: "slot", divisible: false },
  [{ source: "score", direction: "desc" }, { source: "field", key: "students", direction: "desc" }],
  "School Safety Directorate",
);
const inspectionRules = [
  rule("R-01", "Minimum student exposure", "students", "gte", 100),
  rule("R-02", "Recent-incident bonus", "incidents", "gte", 2, "score", 25),
  rule("R-03", "Older-building bonus", "buildingAge", "gte", 30, "score", 15),
  rule("R-04", "Urgent inspection bonus", "urgency", "eq", "high", "score", 20),
];
const inspectionCases = [
  request("C-01", "North Municipal School", { students: 920, buildingAge: 47, incidents: 3, urgency: "high" }, { "inspection-slots": 1 }),
  request("C-02", "Lakeside Primary", { students: 440, buildingAge: 18, incidents: 2, urgency: "medium" }, { "inspection-slots": 1 }),
  request("C-03", "Hillview Secondary", { students: 780, buildingAge: 39, incidents: 1, urgency: "high" }, { "inspection-slots": 1 }),
  request("C-04", "East Ward Academy", { students: 610, buildingAge: 31, incidents: 4, urgency: "medium" }, { "inspection-slots": 1 }),
  request("C-05", "Riverbend School", { students: 90, buildingAge: 12, incidents: 0, urgency: "low" }, { "inspection-slots": 1 }),
  request("C-06", "Old City Girls School", { students: 700, buildingAge: 62, incidents: 2, urgency: "high" }, { "inspection-slots": 1 }),
];

const apiPolicy = policy(
  "Team API Quota",
  "Allocate an API-call quota across teams within an explicitly configured rate window while preserving operational headroom.",
  [
    { key: "businessValue", label: "Business value", type: "integer", min: 1, max: 5 },
    { key: "reliability", label: "Reliability score", type: "integer", min: 1, max: 5 },
    { key: "production", label: "Production workload", type: "boolean" },
    { key: "urgency", label: "Urgency", type: "enum", options: ["low", "medium", "high"] },
  ],
  { id: "api-calls", label: "API call quota", unit: "calls", capacity: 50000, reserve: 5000, strategy: "rate_limit", divisible: false, windowSeconds: 86400 },
  [{ source: "score", direction: "desc" }, { source: "field", key: "businessValue", direction: "desc" }, { source: "demand", key: "api-calls", direction: "asc" }],
  "Platform Reliability Council",
);
const apiRules = [
  rule("R-01", "Per-team quota cap", "demand:api-calls", "lte", 20000),
  rule("R-02", "Minimum reliability", "reliability", "gte", 3),
  rule("R-03", "Production bonus", "production", "eq", true, "score", 20),
  rule("R-04", "High urgency bonus", "urgency", "eq", "high", "score", 15),
];
const apiCases = [
  request("C-01", "Checkout Platform", { businessValue: 5, reliability: 5, production: true, urgency: "high" }, { "api-calls": 18000 }),
  request("C-02", "Fraud Detection", { businessValue: 5, reliability: 4, production: true, urgency: "high" }, { "api-calls": 16000 }),
  request("C-03", "Support Analytics", { businessValue: 3, reliability: 4, production: true, urgency: "medium" }, { "api-calls": 10000 }),
  request("C-04", "Sales Experiment", { businessValue: 3, reliability: 3, production: false, urgency: "low" }, { "api-calls": 12000 }),
  request("C-05", "Prototype Assistant", { businessValue: 2, reliability: 2, production: false, urgency: "low" }, { "api-calls": 8000 }),
];

export const simulationPresets: SimulationPreset[] = [
  { id: "disaster-resilience", title: "Harbor Community Resilience Fund", category: "Money", description: "Rank and fund neighborhood resilience requests.", capability: "All-or-nothing funding", workspace: structuredClone(defaultWorkspace) },
  { id: "mcp-credit-governor", title: "AI Operations Credit Governor", category: "AI credits", description: "Prioritize production agents, preserve operational headroom, and reclaim unused credits after execution.", capability: "Priority + partial allocation + ledger", workspace: makeWorkspace("mcp-credit-governor", mcpPolicy, mcpRules, mcpCases) },
  { id: "rural-healthcare", title: "Rural Healthcare Capacity", category: "Hours", description: "Allocate clinic hours through weighted fair sharing.", capability: "Divisible capacity", workspace: makeWorkspace("rural-healthcare", healthPolicy, healthRules, healthCases) },
  { id: "emergency-supplies", title: "Emergency Supply Allocation", category: "Inventory", description: "Partially distribute kits while honoring minimum deliveries.", capability: "Partial allocation", workspace: makeWorkspace("emergency-supplies", supplyPolicy, supplyRules, supplyCases) },
  { id: "school-inspections", title: "School Safety Inspections", category: "Slots", description: "Assign scarce inspection appointments deterministically.", capability: "Discrete slots", workspace: makeWorkspace("school-inspections", inspectionPolicy, inspectionRules, inspectionCases) },
  { id: "api-quota", title: "Team API Quota", category: "Quota", description: "Allocate rate-window API capacity across teams.", capability: "Rate-limit quota", workspace: makeWorkspace("api-quota", apiPolicy, apiRules, apiCases) },
];

export function presetById(id: string): SimulationPreset | undefined {
  return simulationPresets.find((preset) => preset.id === id);
}
