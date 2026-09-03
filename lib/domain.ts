export type FieldValue = number | string | boolean;
export type FieldType = "number" | "integer" | "enum" | "boolean";
export type Operator = "lt" | "lte" | "gt" | "gte" | "eq" | "neq" | "in" | "not_in" | "between";
export type RuleKind = "threshold" | "score" | "outcome" | "cap";
export type Outcome = "eligible" | "boundary" | "review";
export type AllocationStrategy = "priority_first_fit" | "partial" | "proportional" | "weighted_fair" | "slot" | "rate_limit";

export interface OutcomeLabels { eligible: string; boundary: string; review: string; }
export interface FieldDefinition { key: string; label: string; type: FieldType; unit?: string; options?: string[]; min?: number; max?: number; }
export interface ResourcePool { id: string; label: string; unit: string; capacity: number; reserve: number; strategy: AllocationStrategy; divisible: boolean; windowSeconds?: number; }
export interface RankingCriterion { source: "score" | "field" | "demand"; key?: string; direction: "asc" | "desc"; }
export interface BoundaryPolicy { tolerance: number; maximumFailedRules: number; }
export interface ScoringPolicy { base: number; minimum: number; maximum: number; }
export interface GovernancePolicy { owner: string; status: "draft" | "active" | "retired"; effectiveFrom?: string; effectiveUntil?: string; requireApproval: boolean; requireRationale: boolean; }
export interface Policy { name: string; objective: string; outcomes: OutcomeLabels; fields: FieldDefinition[]; resources: ResourcePool[]; primaryResourceId: string; ranking: RankingCriterion[]; boundary?: BoundaryPolicy; scoring?: ScoringPolicy; governance?: GovernancePolicy; }
export interface RuleCondition { field: string; operator: Operator; value: FieldValue | FieldValue[]; }
export interface PolicyRule { id: string; label: string; conditions: RuleCondition[]; match: "all" | "any"; kind: RuleKind; points: number; result: Outcome | null; resourceId: string | null; amount: number; priority: number; enabled: boolean; }
export interface RequestSource { system: "github"; externalId: string; url: string; importedAt: string; }
export interface TestCase { id: string; name: string; values: Record<string, FieldValue>; demands: Record<string, number>; minimums: Record<string, number>; actualUsage: Record<string, number>; group?: string; source?: RequestSource; }
export type TraceEffect = "passed" | "failed" | "applied" | "not_applied";
export interface TraceStep { ruleId: string; label: string; kind: RuleKind; matched: boolean; effect: TraceEffect; message: string; }
export interface ThresholdProximity { ruleId: string; ruleLabel: string; field: string; operator: Operator; actualValue: number; thresholdValue: number; distance: number; normalizedDistance: number; passed: boolean; }
export interface Evaluation { caseId: string; score: number; outcome: Outcome; failures: string[]; trace: TraceStep[]; caps: Record<string, number>; nearestThreshold: ThresholdProximity | null; nearestFailedThreshold: ThresholdProximity | null; }
export interface ResourceAllocation { resourceId: string; rawRequested: number; requested: number; minimum: number; allocated: number; status: "allocated" | "partial" | "unallocated"; reason: string; }
export interface AllocationDecision { caseId: string; rank: number | null; funded: boolean; fundedAmount: number; reason: string; resources: Record<string, ResourceAllocation>; }
export interface ResourceSummary { resourceId: string; capacity: number; reserve: number; allocatable: number; allocated: number; remaining: number; requested: number; }
export interface PortfolioEvaluation { evaluations: Evaluation[]; allocations: AllocationDecision[]; resources: ResourceSummary[]; allocatedBudget: number; remainingBudget: number; eligibleRequested: number; fundedCount: number; }
export interface SimulationSnapshot { policy: Policy; rules: PolicyRule[]; cases: TestCase[]; }
export interface PolicyVersion { id: string; label: string; rationale: string; createdAt: string; snapshot: SimulationSnapshot; }
export interface ImpactResourceDelta { resourceId: string; before: number; after: number; delta: number; }
export interface ImpactCaseDelta { caseId: string; name: string; beforeOutcome: Outcome | "missing"; afterOutcome: Outcome | "missing"; beforeRank: number | null; afterRank: number | null; resources: ImpactResourceDelta[]; }
export interface PolicyImpactReport {
  id: string;
  label: string;
  rationale: string;
  status: "approved" | "applied";
  actor: "human" | "agent";
  approvedBy: string | null;
  createdAt: string;
  baselineVersionId: string | null;
  candidateVersionId: string;
  policyChanged: boolean;
  changedRules: string[];
  changedRequests: string[];
  outcomeChanges: number;
  rankChanges: number;
  allocationChanges: number;
  affectedCases: ImpactCaseDelta[];
  resources: ImpactResourceDelta[];
}
export interface ActivityEvent { id: string; actor: "human" | "agent" | "engine"; action: string; detail: string; createdAt: string; undoable: boolean; changeKind?: "workspace_replace"; }
export type LedgerEventType = "reserve" | "commit" | "consume" | "release" | "refund";
export interface LedgerEvent { id: string; idempotencyKey: string; requestId: string; resourceId: string; type: LedgerEventType; amount: number; createdAt: string; actor: "human" | "agent" | "engine"; note: string; }
export type ExternalActionId = "github.issue.add_labels" | "github.issue.add_comment" | "github.pull_request.merge" | "github.copilot.assign_issue";
export type ExternalActionArgument = string | number | boolean | string[];
export type ExternalExecutionStatus = "pending_approval" | "approved" | "rejected" | "cancelled" | "succeeded" | "failed";
export type ExternalAuthorizationMode = "human_approval" | "policy_automatic";
export interface ExternalExecutionReceipt { status: "succeeded" | "failed"; externalReference: string; resultUrl?: string; summary: string; actualUsage?: number; recordedAt: string; }
export interface ExternalExecution {
  id: string;
  idempotencyKey: string;
  requestId: string;
  policyVersionId: string;
  actionId: ExternalActionId;
  server: "github";
  tool: "github_add_issue_labels" | "github_add_comment_to_issue" | "github_merge_pull_request" | "assign_copilot_to_issue";
  arguments: Record<string, ExternalActionArgument>;
  argumentsFingerprint: string;
  sourceFingerprint?: string;
  budgetBinding?: { path: string; pointer: string; mode: "total" | "increase"; baseSha: string; amount: number };
  attempt?: { id: string; startedAt: string; state: "dispatching" | "uncertain"; message?: string };
  resourceId: string;
  authorizedAmount: number;
  authorizationMode: ExternalAuthorizationMode;
  status: ExternalExecutionStatus;
  proposedBy: "agent";
  proposedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  cancelledBy?: string | null;
  cancelledAt?: string | null;
  receipt: ExternalExecutionReceipt | null;
}
export interface RequestBatchRow { source: string; url: string; headSha: string; requestId: string; sourceFingerprint: string; name: string; outcome: Outcome; rank: number | null; simulated: number; authorization: number; reason: string; executionId: string | null; }
export interface RequestBatch { id: string; createdAt: string; policyVersionId: string; portfolioFingerprint: string; resourceId: string; unit: string; availableAtReview: number; rows: RequestBatchRow[]; }
export interface InboxRequest {
  requestId: string;
  submissionId: string;
  agent: { id: string; name: string };
  source: { system: string; externalId: string; url?: string };
  resourceId: string;
  reason: string;
  receivedAt: string;
  fingerprint: string;
  execution?: { adapter: "github"; reference: string; budget?: { path: string; pointer: string; mode: "total" | "increase" } };
  decision?: { status: "approved" | "rejected"; amount: number; by: string; at: string; policyVersionId: string; rationale: string; reviewFingerprint: string };
}
export interface WorkspaceData { policy: Policy; rules: PolicyRule[]; cases: TestCase[]; versions: PolicyVersion[]; impactReports: PolicyImpactReport[]; activity: ActivityEvent[]; ledger: LedgerEvent[]; executions: ExternalExecution[]; batches?: RequestBatch[]; inbox?: InboxRequest[]; presetId: string; }
export interface PolicyAuditIssue { severity: "error" | "warning"; code: string; message: string; ruleIds?: string[]; }

export const WORKSPACE_LIMITS = { fields: 20, resources: 8, rules: 50, conditionsPerRule: 8, cases: 100, versions: 30, impactReports: 50, activity: 100, ledger: 5000, ledgerDisplay: 300, executions: 200, undoSnapshots: 10 } as const;
export const defaultOutcomeLabels: OutcomeLabels = { eligible: "Eligible", boundary: "Boundary", review: "Review" };
export const defaultBoundaryPolicy: BoundaryPolicy = { tolerance: 0.25, maximumFailedRules: 1 };
export const defaultScoringPolicy: ScoringPolicy = { base: 50, minimum: 0, maximum: 1000 };
export const defaultGovernancePolicy: GovernancePolicy = { owner: "Policy owner", status: "active", requireApproval: true, requireRationale: true };
export function publicReviewerIdentity(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.includes("@") ? "Workspace owner" : value;
}
export const allocationStrategyLabels: Record<AllocationStrategy, string> = {
  priority_first_fit: "Priority first-fit", partial: "Priority with partial allocation", proportional: "Proportional share", weighted_fair: "Weighted fair share", slot: "Discrete slot assignment", rate_limit: "Rate-window quota",
};
export function resourceRequiresWholeUnits(resource: ResourcePool): boolean {
  const unit = resource.unit.trim().toLowerCase();
  return !resource.divisible || resource.strategy === "slot" || unit === "credits" || unit === "tokens";
}

const copy = <T,>(value: T): T => structuredClone(value);
export const createSnapshot = (policy: Policy, rules: PolicyRule[], cases: TestCase[]): SimulationSnapshot => copy({ policy, rules, cases });

export function primaryResource(policy: Policy): ResourcePool { return policy.resources.find((resource) => resource.id === policy.primaryResourceId) ?? policy.resources[0]; }
export function boundaryPolicy(policy: Policy): BoundaryPolicy { return { ...defaultBoundaryPolicy, ...policy.boundary }; }
export function scoringPolicy(policy: Policy): ScoringPolicy { return { ...defaultScoringPolicy, ...policy.scoring }; }
export function governancePolicy(policy: Policy): GovernancePolicy { return { ...defaultGovernancePolicy, ...policy.governance }; }
function governanceTime(value: string, endOfDay = false): number { return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : value); }
export function policyAllowsExecution(policy: Policy, evaluatedAt: string | Date | number = Date.now()): boolean {
  const governance = governancePolicy(policy); const now = evaluatedAt instanceof Date ? evaluatedAt.getTime() : typeof evaluatedAt === "string" ? Date.parse(evaluatedAt) : evaluatedAt;
  return governance.status === "active" && (!governance.effectiveFrom || governanceTime(governance.effectiveFrom) <= now) && (!governance.effectiveUntil || governanceTime(governance.effectiveUntil, true) >= now);
}
export function fieldDefinition(policy: Policy, key: string): FieldDefinition | undefined { return key.startsWith("demand:") ? undefined : policy.fields.find((field) => field.key === key); }
export function caseValue(testCase: TestCase, field: string): FieldValue | undefined {
  if (field.startsWith("demand:")) return testCase.demands[field.slice(7)] ?? 0;
  if (field.startsWith("minimum:")) return testCase.minimums[field.slice(8)] ?? 0;
  return testCase.values[field];
}
function scalarCompare(actual: FieldValue | undefined, operator: Operator, expected: FieldValue | FieldValue[]): boolean {
  const list = Array.isArray(expected) ? expected : [expected];
  if (operator === "in" || operator === "not_in") { const found = list.some((item) => String(item).toLowerCase() === String(actual).toLowerCase()); return operator === "in" ? found : !found; }
  if (operator === "between") { const [minimum, maximum] = list.map(Number); const numeric = Number(actual); return Number.isFinite(numeric) && Number.isFinite(minimum) && Number.isFinite(maximum) && numeric >= minimum && numeric <= maximum; }
  if (operator === "eq" || operator === "neq") { const equal = typeof actual === "boolean" || typeof expected === "boolean" ? actual === expected : String(actual).toLowerCase() === String(expected).toLowerCase(); return operator === "eq" ? equal : !equal; }
  const numericActual = Number(actual); const numericExpected = Number(expected); if (!Number.isFinite(numericActual) || !Number.isFinite(numericExpected)) return false;
  if (operator === "lt") return numericActual < numericExpected; if (operator === "lte") return numericActual <= numericExpected; if (operator === "gt") return numericActual > numericExpected; return numericActual >= numericExpected;
}
export const conditionPasses = (item: RuleCondition, testCase: TestCase): boolean => scalarCompare(caseValue(testCase, item.field), item.operator, item.value);
export function rulePasses(rule: PolicyRule, testCase: TestCase): boolean { const results = rule.conditions.map((item) => conditionPasses(item, testCase)); return rule.match === "any" ? results.some(Boolean) : results.every(Boolean); }
function conditionProximity(rule: PolicyRule, testCase: TestCase): ThresholdProximity | null {
  const values = rule.conditions.flatMap((item) => {
    if (!["lt", "lte", "gt", "gte"].includes(item.operator)) return [];
    const actual = Number(caseValue(testCase, item.field)); const target = Number(item.value); if (!Number.isFinite(actual) || !Number.isFinite(target)) return [];
    const distance = item.operator === "gte" || item.operator === "gt" ? actual - target : target - actual;
    return [{ ruleId: rule.id, ruleLabel: rule.label, field: item.field, operator: item.operator, actualValue: actual, thresholdValue: target, distance, normalizedDistance: Math.abs(distance) / Math.max(Math.abs(target), 1), passed: scalarCompare(actual, item.operator, item.value) }];
  });
  if (rulePasses(rule, testCase)) return values.sort((a, b) => a.normalizedDistance - b.normalizedDistance)[0] ?? null;
  const failed = values.filter((item) => !item.passed); if (!failed.length) return null;
  if (rule.match === "all") { const failedConditionCount = rule.conditions.filter((item) => !conditionPasses(item, testCase)).length; if (failed.length !== failedConditionCount) return null; return failed.sort((a, b) => b.normalizedDistance - a.normalizedDistance)[0]; }
  return failed.sort((a, b) => a.normalizedDistance - b.normalizedDistance)[0];
}
export function operatorLabel(operator: Operator): string { return ({ lt: "is below", lte: "is at most", gt: "is above", gte: "is at least", eq: "equals", neq: "does not equal", in: "is one of", not_in: "is not one of", between: "is between" } as const)[operator]; }
export function formatValue(value: FieldValue | FieldValue[], unit = ""): string { const formatted = (Array.isArray(value) ? value : [value]).map((item) => typeof item === "number" ? item.toLocaleString() : String(item)).join(" and "); return unit === "USD" ? `$${formatted}` : unit ? `${formatted} ${unit}` : formatted; }
export function formatCondition(item: RuleCondition, policy: Policy): string {
  const resource = item.field.startsWith("demand:") ? policy.resources.find((entry) => entry.id === item.field.slice(7)) : undefined;
  const field = fieldDefinition(policy, item.field); const label = resource ? `${resource.label} request` : field?.label ?? item.field;
  return `${label} ${operatorLabel(item.operator)} ${formatValue(item.value, resource?.unit ?? field?.unit ?? "")}`;
}
export function formatRule(rule: PolicyRule, policy: Policy): string {
  const base = rule.conditions.map((item) => formatCondition(item, policy)).join(rule.match === "all" ? " AND " : " OR ");
  if (rule.kind === "score") return `${base} · ${rule.points >= 0 ? "+" : ""}${rule.points} points`;
  if (rule.kind === "outcome") return `${base} · mark ${rule.result}`;
  if (rule.kind === "cap") return `${base} · cap at ${formatValue(rule.amount, policy.resources.find((resource) => resource.id === rule.resourceId)?.unit)}`;
  return base;
}
export function validateCondition(item: RuleCondition, policy: Policy): string[] {
  const errors: string[] = []; const isDemand = item.field.startsWith("demand:") && policy.resources.some((resource) => resource.id === item.field.slice(7)); const field = policy.fields.find((entry) => entry.key === item.field);
  if (!field && !isDemand) errors.push(`Unknown field: ${item.field}.`);
  const values = Array.isArray(item.value) ? item.value : [item.value];
  if (["lt", "lte", "gt", "gte", "between"].includes(item.operator)) { const numbers = values.map((value) => typeof value === "number" ? value : Number.NaN); if (numbers.some((value) => !Number.isFinite(value))) errors.push(`${item.field} requires numeric comparison values.`); if (item.operator === "between" && numbers.length !== 2) errors.push("Between requires exactly two values."); if (item.operator === "between" && numbers.length === 2 && numbers[0] > numbers[1]) errors.push("Between requires its lower value before its upper value."); }
  if ((item.operator === "in" || item.operator === "not_in") && !Array.isArray(item.value)) errors.push(`${item.operator} requires a list of values.`);
  if (field?.type === "enum") { if (!["eq", "neq", "in", "not_in"].includes(item.operator)) errors.push(`${item.field} supports only equality or membership operators.`); if (values.some((value) => typeof value !== "string" || !field.options?.includes(value))) errors.push(`${item.field} requires configured enum values.`); }
  if (field?.type === "boolean") { if (!["eq", "neq", "in", "not_in"].includes(item.operator)) errors.push(`${item.field} supports only equality or membership operators.`); if (values.some((value) => typeof value !== "boolean")) errors.push(`${item.field} requires boolean comparison values.`); }
  if ((field?.type === "number" || field?.type === "integer" || isDemand) && values.some((value) => typeof value !== "number" || !Number.isFinite(value) || field?.type === "integer" && !Number.isInteger(value))) errors.push(`${item.field} requires ${field?.type === "integer" ? "integer" : "numeric"} comparison values.`);
  return errors;
}
export function validateRule(rule: Omit<PolicyRule, "id" | "enabled"> | PolicyRule, policy: Policy): string[] {
  const errors: string[] = []; if (!rule.label.trim()) errors.push("Rule label is required.");
  if (!rule.conditions.length || rule.conditions.length > WORKSPACE_LIMITS.conditionsPerRule) errors.push(`Rules require 1–${WORKSPACE_LIMITS.conditionsPerRule} conditions.`);
  rule.conditions.forEach((item) => errors.push(...validateCondition(item, policy)));
  if (!Number.isFinite(rule.priority) || rule.priority < 0 || rule.priority > 1000) errors.push("Rule priority must be between 0 and 1,000.");
  if (rule.kind === "score" && (!Number.isFinite(rule.points) || rule.points < -100 || rule.points > 100 || rule.points === 0)) errors.push("Score points must be between -100 and 100 and cannot be zero.");
  if (rule.kind === "outcome" && !rule.result) errors.push("Outcome rules require a result.");
  if (rule.kind === "cap" && (!rule.resourceId || !policy.resources.some((resource) => resource.id === rule.resourceId) || !Number.isFinite(rule.amount) || rule.amount < 0)) errors.push("Cap rules require a valid resource and non-negative amount.");
  if (rule.kind === "cap" && rule.resourceId) { const resource = policy.resources.find((item) => item.id === rule.resourceId); if (resource && resourceRequiresWholeUnits(resource) && !Number.isInteger(rule.amount)) errors.push(`Caps for ${resource.label} must use whole ${resource.unit}.`); }
  return errors;
}
export function auditPolicy(policy: Policy, rules: PolicyRule[], cases: TestCase[] = []): PolicyAuditIssue[] {
  const issues: PolicyAuditIssue[] = []; const enabled = rules.filter((rule) => rule.enabled); const thresholds = enabled.filter((rule) => rule.kind === "threshold"); const governance = governancePolicy(policy);
  if (!thresholds.length) issues.push({ severity: "warning", code: "NO_ELIGIBILITY_GATES", message: "No enabled eligibility threshold exists; every request can enter ranking unless an outcome rule intervenes." });
  if (governance.status === "draft") issues.push({ severity: "warning", code: "DRAFT_POLICY", message: "This policy is still marked draft." });
  if (governance.status === "retired") issues.push({ severity: "error", code: "RETIRED_POLICY", message: "This policy is retired and should not govern new execution." });
  const today = Date.now(); if (governance.effectiveFrom && governanceTime(governance.effectiveFrom) > today) issues.push({ severity: "warning", code: "NOT_EFFECTIVE", message: `Policy becomes effective on ${governance.effectiveFrom}.` }); if (governance.effectiveUntil && governanceTime(governance.effectiveUntil, true) < today) issues.push({ severity: "error", code: "EXPIRED_POLICY", message: `Policy expired on ${governance.effectiveUntil}.` });
  const canonicalConditions = (rule: PolicyRule) => [...rule.conditions].map((condition) => ({ ...condition, value: (condition.operator === "in" || condition.operator === "not_in") && Array.isArray(condition.value) ? [...condition.value].sort((left, right) => String(left).localeCompare(String(right))) : condition.value })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const duplicateGroups = new Map<string, PolicyRule[]>(); for (const rule of enabled) { const signature = JSON.stringify({ kind: rule.kind, conditions: canonicalConditions(rule), match: rule.match, points: rule.points, result: rule.result, resourceId: rule.resourceId, amount: rule.amount }); duplicateGroups.set(signature, [...(duplicateGroups.get(signature) ?? []), rule]); }
  for (const group of duplicateGroups.values()) if (group.length > 1) { const scoreDuplicate = group[0].kind === "score"; issues.push({ severity: scoreDuplicate ? "error" : "warning", code: "DUPLICATE_RULE", message: `Rules ${group.map((rule) => rule.id).join(" and ")} are semantic duplicates${scoreDuplicate ? " and would double-count score" : ""}.`, ruleIds: group.map((rule) => rule.id) }); }
  const outcomeGroups = new Map<string, PolicyRule[]>(); for (const rule of enabled.filter((item) => item.kind === "outcome")) { const signature = JSON.stringify({ conditions: canonicalConditions(rule), match: rule.match }); outcomeGroups.set(signature, [...(outcomeGroups.get(signature) ?? []), rule]); }
  for (const group of outcomeGroups.values()) if (new Set(group.map((rule) => rule.result)).size > 1) issues.push({ severity: "error", code: "CONFLICTING_OUTCOME", message: `Rules ${group.map((rule) => rule.id).join(" and ")} assign conflicting outcomes to the same condition.`, ruleIds: group.map((rule) => rule.id) });
  const bounds = new Map<string, { lower: number; lowerStrict: boolean; upper: number; upperStrict: boolean; ids: string[] }>();
  for (const rule of thresholds) { if (rule.match !== "all" || rule.conditions.length !== 1) continue; const condition = rule.conditions[0]; if (typeof condition.value !== "number" || !["gt", "gte", "lt", "lte", "eq"].includes(condition.operator)) continue; const current = bounds.get(condition.field) ?? { lower: Number.NEGATIVE_INFINITY, lowerStrict: false, upper: Number.POSITIVE_INFINITY, upperStrict: false, ids: [] }; current.ids.push(rule.id); if (condition.operator === "gt" || condition.operator === "gte" || condition.operator === "eq") { if (condition.value > current.lower || condition.value === current.lower && condition.operator === "gt") { current.lower = condition.value; current.lowerStrict = condition.operator === "gt"; } } if (condition.operator === "lt" || condition.operator === "lte" || condition.operator === "eq") { if (condition.value < current.upper || condition.value === current.upper && condition.operator === "lt") { current.upper = condition.value; current.upperStrict = condition.operator === "lt"; } } bounds.set(condition.field, current); }
  for (const [field, bound] of bounds) if (bound.lower > bound.upper || bound.lower === bound.upper && (bound.lowerStrict || bound.upperStrict)) issues.push({ severity: "error", code: "IMPOSSIBLE_THRESHOLD", message: `${field} has contradictory enabled thresholds.`, ruleIds: bound.ids });
  for (const rule of enabled.filter((item) => item.kind === "cap" && item.resourceId)) { const affected = cases.filter((item) => rulePasses(rule, item) && rule.amount + 0.000001 < (item.minimums[rule.resourceId!] ?? 0)); if (affected.length) issues.push({ severity: "warning", code: "CAP_BELOW_MINIMUM", message: `${rule.id} caps ${affected.length} matching request${affected.length === 1 ? "" : "s"} below their declared minimum useful amount.`, ruleIds: [rule.id] }); }
  return issues;
}
export function policyExecutionIssues(policy: Policy, rules: PolicyRule[], cases: TestCase[] = []): PolicyAuditIssue[] {
  return auditPolicy(policy, rules, cases).flatMap((issue) => {
    if (issue.severity === "error") return [issue];
    if (issue.code === "DRAFT_POLICY") return [{ ...issue, severity: "error" as const, message: "This policy is still draft and cannot govern resource execution." }];
    if (issue.code === "NOT_EFFECTIVE") return [{ ...issue, severity: "error" as const, message: `${issue.message} Resource execution is blocked until then.` }];
    return [];
  });
}
export function evaluateCase(testCase: TestCase, rules: PolicyRule[], policy: Policy): Evaluation {
  const enabledRules = rules.filter((rule) => rule.enabled).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const thresholdRules = enabledRules.filter((rule) => rule.kind === "threshold");
  const boundary = boundaryPolicy(policy); const scoring = scoringPolicy(policy);
  const trace = enabledRules.map((rule) => {
    const matched = rulePasses(rule, testCase), gate = rule.kind === "threshold";
    const effect: TraceEffect = gate ? (matched ? "passed" : "failed") : (matched ? "applied" : "not_applied");
    const result = effect === "not_applied" ? "not applied" : effect;
    return { ruleId: rule.id, label: rule.label, kind: rule.kind, matched, effect, message: `${formatRule(rule, policy)} — ${result}` };
  });
  const failures = thresholdRules.filter((rule) => !rulePasses(rule, testCase)).map((rule) => rule.id);
  const score = Math.max(scoring.minimum, Math.min(scoring.maximum, enabledRules.filter((rule) => rule.kind === "score" && rulePasses(rule, testCase)).reduce((total, rule) => total + rule.points, scoring.base)));
  const proximities = thresholdRules.map((rule) => conditionProximity(rule, testCase)).filter((item): item is ThresholdProximity => Boolean(item)).sort((a, b) => a.normalizedDistance - b.normalizedDistance);
  const failedProximities = proximities.filter((item) => !item.passed); const nearestThreshold = proximities[0] ?? null; const nearestFailedThreshold = failedProximities[0] ?? null;
  const isBoundary = failures.length > 0 && failures.length <= boundary.maximumFailedRules && failedProximities.length === failures.length && failedProximities.every((item) => item.normalizedDistance <= boundary.tolerance);
  let outcome: Outcome = failures.length === 0 ? "eligible" : isBoundary ? "boundary" : "review";
  const outcomeRule = enabledRules.find((rule) => rule.kind === "outcome" && rule.result && rulePasses(rule, testCase)); if (outcomeRule?.result) outcome = outcomeRule.result;
  const caps = Object.fromEntries(policy.resources.map((resource) => [resource.id, Number.POSITIVE_INFINITY]));
  for (const rule of enabledRules.filter((item) => item.kind === "cap" && item.resourceId && rulePasses(item, testCase))) caps[rule.resourceId!] = Math.min(caps[rule.resourceId!] ?? Number.POSITIVE_INFINITY, rule.amount);
  return { caseId: testCase.id, score, outcome, failures, trace, caps, nearestThreshold, nearestFailedThreshold };
}
export const evaluateAll = (cases: TestCase[], rules: PolicyRule[], policy: Policy) => cases.map((item) => evaluateCase(item, rules, policy));
function compareValues(left: FieldValue | undefined, right: FieldValue | undefined, direction: "asc" | "desc"): number { const nl = Number(left), nr = Number(right); const base = Number.isFinite(nl) && Number.isFinite(nr) ? nl - nr : String(left ?? "").localeCompare(String(right ?? "")); return direction === "asc" ? base : -base; }
function rankingFieldValue(testCase: TestCase, key: string, policy: Policy): FieldValue | undefined {
  const value = testCase.values[key], field = policy.fields.find((item) => item.key === key);
  if (field?.type === "enum") return field.options?.indexOf(String(value)) ?? -1;
  if (field?.type === "boolean") return value === true ? 1 : 0;
  return value;
}
function effectiveDemand(testCase: TestCase, resourceId: string, evaluations: Map<string, Evaluation>): number {
  return Math.max(0, Math.min(testCase.demands[resourceId] ?? 0, evaluations.get(testCase.id)?.caps[resourceId] ?? Number.POSITIVE_INFINITY));
}
function rankedCases(cases: TestCase[], evaluations: Evaluation[], policy: Policy): TestCase[] {
  const map = new Map(evaluations.map((item) => [item.caseId, item]));
  return cases.filter((item) => map.get(item.id)?.outcome === "eligible").sort((left, right) => {
    for (const criterion of policy.ranking) {
      const lv = criterion.source === "score" ? map.get(left.id)?.score : criterion.source === "demand" ? effectiveDemand(left, criterion.key ?? policy.primaryResourceId, map) : rankingFieldValue(left, criterion.key ?? "", policy);
      const rv = criterion.source === "score" ? map.get(right.id)?.score : criterion.source === "demand" ? effectiveDemand(right, criterion.key ?? policy.primaryResourceId, map) : rankingFieldValue(right, criterion.key ?? "", policy);
      const compared = compareValues(lv, rv, criterion.direction); if (compared) return compared;
    }
    return left.id.localeCompare(right.id);
  });
}
function rounded(value: number, resource: ResourcePool): number { if (resourceRequiresWholeUnits(resource)) return Math.max(0, Math.floor(value)); return Math.max(0, Math.round(value * 100) / 100); }
function distributeShares(resource: ResourcePool, ranked: TestCase[], evaluations: Map<string, Evaluation>, demandFor: (item: TestCase) => number, minimumFor: (item: TestCase) => number): Map<string, number> {
  const calculate = (included: TestCase[]): Map<string, number> => {
    const result = new Map<string, number>(); let remaining = Math.max(0, resource.capacity - resource.reserve); let candidates = [...included];
    while (remaining > 0.000001 && candidates.length) {
      const weights = candidates.map((item) => resource.strategy === "weighted_fair" ? Math.max(1, evaluations.get(item.id)?.score ?? 1) : demandFor(item)); const totalWeight = weights.reduce((sum, value) => sum + value, 0); if (totalWeight <= 0) break;
      let spent = 0; candidates.forEach((item, index) => { const current = result.get(item.id) ?? 0; const need = Math.max(0, demandFor(item) - current); const share = Math.min(need, remaining * (weights[index] / totalWeight)); result.set(item.id, current + share); spent += share; });
      if (spent <= 0.000001) break; remaining -= spent; candidates = candidates.filter((item) => (result.get(item.id) ?? 0) + 0.000001 < demandFor(item));
    }
    const normalized = new Map<string, number>(); let normalizedTotal = 0; for (const item of included) { const value = rounded(result.get(item.id) ?? 0, resource); normalized.set(item.id, value); normalizedTotal += value; }
    let remainder = rounded(Math.max(0, resource.capacity - resource.reserve - normalizedTotal), resource);
    for (const item of included) { if (remainder <= 0) break; const need = rounded(demandFor(item) - (normalized.get(item.id) ?? 0), resource); const add = Math.min(need, resource.divisible ? remainder : Math.floor(remainder)); if (add > 0) { normalized.set(item.id, (normalized.get(item.id) ?? 0) + add); remainder -= add; } }
    return normalized;
  };
  let included = ranked.filter((item) => demandFor(item) > 0);
  while (included.length) {
    const shares = calculate(included); const belowMinimum = included.filter((item) => { const share = shares.get(item.id) ?? 0; return share > 0 && share + 0.000001 < minimumFor(item); });
    if (!belowMinimum.length) return new Map(ranked.map((item) => [item.id, shares.get(item.id) ?? 0]));
    const lowestRankedBelowMinimum = belowMinimum.at(-1)!; included = included.filter((item) => item.id !== lowestRankedBelowMinimum.id);
  }
  return new Map(ranked.map((item) => [item.id, 0]));
}
export function allocateResources(cases: TestCase[], rules: PolicyRule[], policy: Policy): PortfolioEvaluation {
  const evaluations = evaluateAll(cases, rules, policy); const evaluationMap = new Map(evaluations.map((item) => [item.caseId, item])); const ranked = rankedCases(cases, evaluations, policy); const rankMap = new Map(ranked.map((item, index) => [item.id, index + 1])); const byCase = new Map<string, Record<string, ResourceAllocation>>(cases.map((item) => [item.id, {}])); const summaries: ResourceSummary[] = [];
  for (const resource of policy.resources) {
    const demandFor = (item: TestCase) => effectiveDemand(item, resource.id, evaluationMap); const minimumFor = (item: TestCase) => Math.max(0, item.minimums[resource.id] ?? (resource.strategy === "partial" ? 0 : demandFor(item))); const allocatable = Math.max(0, resource.capacity - resource.reserve); let remaining = allocatable;
    const shares = resource.strategy === "proportional" || resource.strategy === "weighted_fair" ? distributeShares(resource, ranked, evaluationMap, demandFor, minimumFor) : null;
    const allocationOrder = [...ranked, ...cases.filter((item) => !rankMap.has(item.id))];
    for (const item of allocationOrder) {
      const evaluation = evaluationMap.get(item.id)!; const rawRequested = Math.max(0, item.demands[resource.id] ?? 0); const requested = demandFor(item); const minimum = minimumFor(item); let allocated = 0;
      const feasible = requested + 0.000001 >= minimum;
      if (evaluation.outcome === "eligible" && requested > 0 && feasible) {
        if (shares) allocated = shares.get(item.id) ?? 0;
        else if (resource.strategy === "partial") { const candidate = rounded(Math.min(requested, remaining), resource); allocated = candidate >= minimum ? candidate : 0; remaining -= allocated; }
        else { const candidate = rounded(requested, resource); allocated = candidate <= remaining ? candidate : 0; remaining -= allocated; }
      }
      allocated = rounded(allocated, resource); const status = allocated <= 0 ? "unallocated" : allocated + 0.000001 >= requested ? "allocated" : "partial";
      byCase.get(item.id)![resource.id] = { resourceId: resource.id, rawRequested, requested, minimum, allocated, status, reason: evaluation.outcome !== "eligible" ? `Not allocated because the request is ${evaluation.outcome}.` : !feasible ? "Not allocated because the policy cap is below the declared minimum useful amount." : status === "allocated" ? `Allocated by ${allocationStrategyLabels[resource.strategy]}.` : status === "partial" ? `Partially allocated by ${allocationStrategyLabels[resource.strategy]}; the minimum useful amount is satisfied.` : "Eligible, but available capacity is insufficient to satisfy the minimum useful allocation." };
    }
    const allocated = cases.reduce((sum, item) => sum + (byCase.get(item.id)?.[resource.id]?.allocated ?? 0), 0); summaries.push({ resourceId: resource.id, capacity: resource.capacity, reserve: resource.reserve, allocatable, allocated, remaining: Math.max(0, allocatable - allocated), requested: ranked.reduce((sum, item) => sum + demandFor(item), 0) });
  }
  const primary = primaryResource(policy); const allocations = cases.map((item) => { const resources = byCase.get(item.id) ?? {}; const main = resources[primary.id]; const demanded = policy.resources.filter((resource) => (item.demands[resource.id] ?? 0) > 0); const funded = demanded.length > 0 && evaluationMap.get(item.id)?.outcome === "eligible" && demanded.every((resource) => resources[resource.id]?.status === "allocated"); return { caseId: item.id, rank: rankMap.get(item.id) ?? null, funded, fundedAmount: main?.allocated ?? 0, reason: main?.reason ?? "No primary-resource demand.", resources }; });
  const primarySummary = summaries.find((item) => item.resourceId === primary.id) ?? { allocated: 0, remaining: 0, requested: 0 };
  return { evaluations, allocations, resources: summaries, allocatedBudget: primarySummary.allocated, remainingBudget: primarySummary.remaining, eligibleRequested: primarySummary.requested, fundedCount: allocations.filter((item) => item.funded).length };
}
export function allocateWorkspaceResources(workspace: Pick<WorkspaceData, "cases" | "rules" | "policy" | "inbox">): PortfolioEvaluation {
  const declined = new Set(workspace.inbox?.filter((item) => item.decision?.status === "rejected").map((item) => item.requestId));
  const portfolio = allocateResources(workspace.cases.filter((item) => !declined.has(item.id)), workspace.rules, workspace.policy);
  // Retain declined inputs for inspection without allowing them to compete again.
  if (declined.size) {
    const history = allocateResources(workspace.cases.filter((item) => declined.has(item.id)), workspace.rules, workspace.policy);
    portfolio.evaluations.push(...history.evaluations);
    portfolio.allocations.push(...history.allocations.map((allocation) => ({ ...allocation, rank: null, funded: false, fundedAmount: 0, reason: "Request declined; no budget held.", resources: Object.fromEntries(Object.entries(allocation.resources).map(([id, result]) => [id, { ...result, allocated: 0, status: "unallocated" as const, reason: "Request declined; no budget held." }])) })));
  }
  return portfolio;
}
export function findBoundaryCases(cases: TestCase[], rules: PolicyRule[], policy: Policy) { const tolerance = boundaryPolicy(policy).tolerance; return evaluateAll(cases, rules, policy).filter((item) => { const proximity = item.nearestFailedThreshold ?? item.nearestThreshold; return proximity && proximity.normalizedDistance <= tolerance; }).sort((a, b) => { const ad = (a.nearestFailedThreshold ?? a.nearestThreshold)?.normalizedDistance ?? 1; const bd = (b.nearestFailedThreshold ?? b.nearestThreshold)?.normalizedDistance ?? 1; return Number(!a.nearestFailedThreshold) - Number(!b.nearestFailedThreshold) || ad - bd; }); }
export function outcomeCounts(evaluations: Evaluation[]) { return evaluations.reduce((counts, item) => ({ ...counts, [item.outcome]: counts[item.outcome] + 1 }), { eligible: 0, boundary: 0, review: 0 } as Record<Outcome, number>); }
export function compareSimulationSnapshots(baseline: SimulationSnapshot, candidate: SimulationSnapshot) {
  const baselineRules = new Map(baseline.rules.map((rule) => [rule.id, rule])); const candidateRules = new Map(candidate.rules.map((rule) => [rule.id, rule])); const allRuleIds = [...new Set([...baselineRules.keys(), ...candidateRules.keys()])];
  const changedRules = allRuleIds.filter((id) => JSON.stringify(baselineRules.get(id) ?? null) !== JSON.stringify(candidateRules.get(id) ?? null)).map((id) => ({ id, before: baselineRules.get(id) ?? null, after: candidateRules.get(id) ?? null }));
  const baselineCases = new Map(baseline.cases.map((item) => [item.id, item])); const candidateCases = new Map(candidate.cases.map((item) => [item.id, item])); const allCaseIds = [...new Set([...baselineCases.keys(), ...candidateCases.keys()])];
  const comparableCase = (item: TestCase | undefined) => item ? { id: item.id, name: item.name, values: item.values, demands: item.demands, minimums: item.minimums, group: item.group } : null;
  const changedRequests = allCaseIds.filter((id) => JSON.stringify(comparableCase(baselineCases.get(id))) !== JSON.stringify(comparableCase(candidateCases.get(id))));
  const beforePortfolio = allocateResources(baseline.cases, baseline.rules, baseline.policy); const afterPortfolio = allocateResources(candidate.cases, candidate.rules, candidate.policy);
  const beforeEvaluations = new Map(beforePortfolio.evaluations.map((item) => [item.caseId, item])); const afterEvaluations = new Map(afterPortfolio.evaluations.map((item) => [item.caseId, item]));
  const beforeAllocations = new Map(beforePortfolio.allocations.map((item) => [item.caseId, item])); const afterAllocations = new Map(afterPortfolio.allocations.map((item) => [item.caseId, item]));
  const changedCases = allCaseIds.map((id) => ({ testCase: candidateCases.get(id) ?? baselineCases.get(id)!, before: beforeEvaluations.get(id), after: afterEvaluations.get(id) })).filter((item) => item.before?.outcome !== item.after?.outcome);
  const allocationCandidates = allCaseIds.map((id) => ({ testCase: candidateCases.get(id) ?? baselineCases.get(id)!, before: beforeAllocations.get(id), after: afterAllocations.get(id) }));
  const changedRanks = allocationCandidates.filter((item) => item.before?.rank !== item.after?.rank);
  const changedAllocations = allocationCandidates.filter((item) => {
    if (item.before?.funded !== item.after?.funded) return true;
    const resourceIds = new Set([...Object.keys(item.before?.resources ?? {}), ...Object.keys(item.after?.resources ?? {})]);
    return [...resourceIds].some((resourceId) => Math.abs((item.before?.resources[resourceId]?.allocated ?? 0) - (item.after?.resources[resourceId]?.allocated ?? 0)) > 0.000001);
  });
  return { policyChanged: JSON.stringify(baseline.policy) !== JSON.stringify(candidate.policy), changedRules, changedRequests, changedCases, changedRanks, changedAllocations, before: beforePortfolio.evaluations, after: afterPortfolio.evaluations, beforePortfolio, afterPortfolio };
}
export function createPolicyImpactReport(input: {
  id: string;
  label: string;
  rationale: string;
  actor: PolicyImpactReport["actor"];
  baseline: SimulationSnapshot;
  candidate: SimulationSnapshot;
  baselineVersionId?: string | null;
  candidateVersionId: string;
  createdAt?: string;
  approvedBy?: string | null;
}): PolicyImpactReport {
  const comparison = compareSimulationSnapshots(input.baseline, input.candidate);
  const baselineCases = new Map(input.baseline.cases.map((item) => [item.id, item]));
  const candidateCases = new Map(input.candidate.cases.map((item) => [item.id, item]));
  const beforeEvaluations = new Map(comparison.beforePortfolio.evaluations.map((item) => [item.caseId, item]));
  const afterEvaluations = new Map(comparison.afterPortfolio.evaluations.map((item) => [item.caseId, item]));
  const beforeAllocations = new Map(comparison.beforePortfolio.allocations.map((item) => [item.caseId, item]));
  const afterAllocations = new Map(comparison.afterPortfolio.allocations.map((item) => [item.caseId, item]));
  const resourceIds = [...new Set([...input.baseline.policy.resources.map((item) => item.id), ...input.candidate.policy.resources.map((item) => item.id)])];
  const affectedIds = [...new Set([...comparison.changedRequests, ...comparison.changedCases.map((item) => item.testCase.id), ...comparison.changedRanks.map((item) => item.testCase.id), ...comparison.changedAllocations.map((item) => item.testCase.id)])].sort();
  const affectedCases = affectedIds.map((caseId): ImpactCaseDelta => {
    const before = beforeAllocations.get(caseId), after = afterAllocations.get(caseId);
    return {
      caseId,
      name: candidateCases.get(caseId)?.name ?? baselineCases.get(caseId)?.name ?? caseId,
      beforeOutcome: beforeEvaluations.get(caseId)?.outcome ?? "missing",
      afterOutcome: afterEvaluations.get(caseId)?.outcome ?? "missing",
      beforeRank: before?.rank ?? null,
      afterRank: after?.rank ?? null,
      resources: resourceIds.map((resourceId) => {
        const beforeAmount = before?.resources[resourceId]?.allocated ?? 0;
        const afterAmount = after?.resources[resourceId]?.allocated ?? 0;
        return { resourceId, before: beforeAmount, after: afterAmount, delta: afterAmount - beforeAmount };
      }),
    };
  });
  const beforeResources = new Map(comparison.beforePortfolio.resources.map((item) => [item.resourceId, item]));
  const afterResources = new Map(comparison.afterPortfolio.resources.map((item) => [item.resourceId, item]));
  return {
    id: input.id, label: input.label, rationale: input.rationale, status: input.approvedBy ? "approved" : "applied", actor: input.actor, approvedBy: input.approvedBy ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(), baselineVersionId: input.baselineVersionId ?? null, candidateVersionId: input.candidateVersionId,
    policyChanged: comparison.policyChanged, changedRules: comparison.changedRules.map((item) => item.id), changedRequests: comparison.changedRequests,
    outcomeChanges: comparison.changedCases.length, rankChanges: comparison.changedRanks.length, allocationChanges: comparison.changedAllocations.length, affectedCases,
    resources: resourceIds.map((resourceId) => {
      const before = beforeResources.get(resourceId)?.allocated ?? 0, after = afterResources.get(resourceId)?.allocated ?? 0;
      return { resourceId, before, after, delta: after - before };
    }),
  };
}
export function compareRuleSets(baseline: PolicyRule[], candidate: PolicyRule[], cases: TestCase[], policy: Policy) {
  const baselineMap = new Map(baseline.map((rule) => [rule.id, rule])); const candidateMap = new Map(candidate.map((rule) => [rule.id, rule])); const allIds = [...new Set([...baselineMap.keys(), ...candidateMap.keys()])]; const changedRules = allIds.filter((id) => JSON.stringify(baselineMap.get(id) ?? null) !== JSON.stringify(candidateMap.get(id) ?? null)).map((id) => ({ id, before: baselineMap.get(id) ?? null, after: candidateMap.get(id) ?? null }));
  const result = compareSimulationSnapshots({ policy, rules: baseline, cases }, { policy, rules: candidate, cases }); return { ...result, changedRules };
}
export function nextId(prefix: string, items: { id: string }[]) { const max = items.reduce((current, item) => { const numeric = Number(item.id.replace(/\D/g, "")); return Number.isFinite(numeric) ? Math.max(current, numeric) : current; }, 0); return `${prefix}-${String(max + 1).padStart(2, "0")}`; }
export function nextRuleId(workspace: Pick<WorkspaceData, "rules" | "versions">) { return nextId("R", [...workspace.rules, ...workspace.versions.flatMap((version) => version.snapshot.rules)]); }
export function ruleValueDiffers(rule: PolicyRule, candidateValue: RuleCondition["value"]): boolean { return JSON.stringify(rule.conditions[0]?.value) !== JSON.stringify(candidateValue); }

export interface LedgerState { capacity: number; policyReserve: number; reserved: number; committed: number; consumed: number; available: number; }
export function resourceLedgerState(resource: ResourcePool, events: LedgerEvent[], evaluatedAt: string | Date = new Date()): LedgerState {
  let reserved = 0, committed = 0, consumed = 0;
  const requests = new Map<string, { reserved: number; committed: number; consumed: number }>();
  const evaluationTime = evaluatedAt instanceof Date ? evaluatedAt.getTime() : Date.parse(evaluatedAt);
  const windowStart = resource.strategy === "rate_limit" && resource.windowSeconds
    ? evaluationTime - resource.windowSeconds * 1000
    : Number.NEGATIVE_INFINITY;
  for (const event of events.filter((item) => item.resourceId === resource.id)) {
    const state = requests.get(event.requestId) ?? { reserved: 0, committed: 0, consumed: 0 };
    requests.set(event.requestId, state);
    const eventTime = Date.parse(event.createdAt);
    const activeConsumption = resource.strategy !== "rate_limit" || (eventTime >= windowStart && eventTime <= evaluationTime);
    if (event.type === "reserve") state.reserved += event.amount;
    if (event.type === "commit") { state.reserved -= event.amount; state.committed += event.amount; }
    if (event.type === "consume") { state.committed -= event.amount; if (activeConsumption) state.consumed += event.amount; }
    // Releases belong to one request, never to another agent's reservation.
    if (event.type === "release") { const fromReserved = Math.min(state.reserved, event.amount); state.reserved -= fromReserved; state.committed -= Math.min(state.committed, event.amount - fromReserved); }
    if (event.type === "refund" && activeConsumption) state.consumed -= event.amount;
  }
  for (const state of requests.values()) { reserved += Math.max(0, state.reserved); committed += Math.max(0, state.committed); consumed += Math.max(0, state.consumed); }
  reserved = Math.max(0, reserved); committed = Math.max(0, committed); consumed = Math.max(0, consumed);
  return { capacity: resource.capacity, policyReserve: resource.reserve, reserved, committed, consumed, available: Math.max(0, resource.capacity - resource.reserve - reserved - committed - consumed) };
}
// Allocate only remaining work against spendable capacity. Simulation remains
// a separate counterfactual; it must not strand capacity after grants settle.
export function planWorkspaceBudget(workspace: WorkspaceData, resourceId: string) {
  const resource = workspace.policy.resources.find((item) => item.id === resourceId);
  if (!resource) throw new Error("Resource pool not found.");
  const portfolio = allocateWorkspaceResources(workspace);
  const evaluations = new Map(portfolio.evaluations.map((item) => [item.caseId, item]));
  const available = resourceLedgerState(resource, workspace.ledger).available;
  const pending = workspace.executions.filter((item) => item.resourceId === resourceId && item.status === "pending_approval");
  const spendable = Math.max(0, available - pending.reduce((sum, item) => sum + item.authorizedAmount, 0));
  const rows = [...portfolio.allocations].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.caseId.localeCompare(b.caseId)).map((allocation) => {
    const request = workspace.cases.find((item) => item.id === allocation.caseId)!;
    const held = resourceLedgerState({ ...resource, capacity: Number.MAX_SAFE_INTEGER, reserve: 0 }, workspace.ledger.filter((event) => event.requestId === request.id && event.resourceId === resourceId));
    const proposed = pending.filter((item) => item.requestId === request.id).reduce((sum, item) => sum + item.authorizedAmount, 0);
    const accounted = held.reserved + held.committed + held.consumed + proposed;
    const originalDemand = effectiveDemand(request, resourceId, evaluations);
    const minimum = request.minimums[resourceId] ?? (resource.strategy === "partial" ? 0 : originalDemand);
    const decided = workspace.inbox?.some((item) => item.requestId === request.id && item.decision);
    const outstanding = decided || originalDemand < minimum ? 0 : Math.max(0, originalDemand - accounted);
    return { request, allocation, evaluation: evaluations.get(request.id)!, simulated: allocation.resources[resourceId].allocated, amount: 0, held, pending: proposed, outstanding, minimum: Math.max(0, minimum - accounted) };
  });
  const byId = new Map(rows.map((row) => [row.request.id, row]));
  const ranked = rows.filter((row) => row.evaluation.outcome === "eligible" && row.outstanding > 0).map((row) => row.request);
  const shares = resource.strategy === "proportional" || resource.strategy === "weighted_fair" ? distributeShares({ ...resource, capacity: spendable, reserve: 0 }, ranked, evaluations, (item) => byId.get(item.id)!.outstanding, (item) => byId.get(item.id)!.minimum) : null;
  let remaining = spendable;
  for (const request of ranked) {
    const row = byId.get(request.id)!;
    const candidate = shares ? shares.get(request.id) ?? 0 : resource.strategy === "partial" ? rounded(Math.min(row.outstanding, remaining), resource) : rounded(row.outstanding, resource);
    row.amount = candidate >= row.minimum && candidate <= remaining + 0.000001 ? candidate : 0;
    remaining = Math.max(0, remaining - row.amount);
  }
  return { resource, available, remaining, rows };
}
export type LedgerEventInput = Omit<LedgerEvent, "id" | "createdAt">;
export function appendLedgerEvent(workspace: WorkspaceData, input: LedgerEventInput): { workspace: WorkspaceData; event: LedgerEvent; duplicate: boolean } {
  const duplicate = workspace.ledger.find((event) => event.idempotencyKey === input.idempotencyKey);
  if (duplicate) {
    if (duplicate.requestId !== input.requestId || duplicate.resourceId !== input.resourceId || duplicate.type !== input.type || duplicate.amount !== input.amount || duplicate.actor !== input.actor) throw new Error("Idempotency key was already used for a different ledger operation.");
    return { workspace, event: duplicate, duplicate: true };
  }
  if (workspace.ledger.length >= WORKSPACE_LIMITS.ledger) throw new Error("Ledger storage limit reached. Export the audit file before starting a new workspace.");
  if (input.type === "reserve") { const blockers = policyExecutionIssues(workspace.policy, workspace.rules, workspace.cases); if (blockers.length) throw new Error(`New reservations require an active policy with no blocking errors: ${blockers.map((issue) => issue.message).join(" ")}`); }
  const resource = workspace.policy.resources.find((item) => item.id === input.resourceId); if (!resource) throw new Error("Resource pool not found."); if (!workspace.cases.some((item) => item.id === input.requestId)) throw new Error("Request not found."); if (!input.idempotencyKey.trim()) throw new Error("An idempotency key is required."); if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("Ledger amount must be greater than zero."); if (resourceRequiresWholeUnits(resource) && !Number.isInteger(input.amount)) throw new Error(`${resource.label} ledger amounts must use whole ${resource.unit}.`);
  const relevant = workspace.ledger.filter((event) => event.resourceId === input.resourceId && event.requestId === input.requestId); const globalState = resourceLedgerState(resource, workspace.ledger); const requestState = resourceLedgerState({ ...resource, capacity: Number.MAX_SAFE_INTEGER, reserve: 0 }, relevant);
  if (input.type === "reserve") {
    const incoming = workspace.inbox?.find((item) => item.requestId === input.requestId);
    if (incoming && !incoming.execution && input.idempotencyKey !== `inbox:${input.requestId}:reserve`) throw new Error("Authorize incoming budget through the request inbox.");
    if (workspace.inbox?.some((item) => item.requestId === input.requestId && item.decision)) throw new Error("This incoming request already has a budget decision. Submit a new request for additional capacity.");
    // An exact pending action already holds its proposed share; converting it
    // to a reservation must not subtract that same share a second time.
    const reserving = workspace.executions.find((item) => item.status === "pending_approval" && `${item.idempotencyKey}:reserve` === input.idempotencyKey && item.requestId === input.requestId && item.resourceId === input.resourceId);
    const planned = planWorkspaceBudget(reserving ? { ...workspace, executions: workspace.executions.filter((item) => item.id !== reserving.id) } : workspace, input.resourceId).rows.find((item) => item.request.id === input.requestId);
    const allocationAvailable = planned?.amount ?? 0;
    if (allocationAvailable <= 0) throw new Error("This request has no remaining policy allocation to reserve.");
    if (input.amount > allocationAvailable + 0.000001) throw new Error("Reservation exceeds this request's remaining simulated allocation.");
    if (input.amount > globalState.available + 0.000001) throw new Error("Insufficient available capacity for this reservation.");
  }
  if (input.type === "commit" && input.amount > requestState.reserved) throw new Error("Cannot commit more than this request has reserved."); if (input.type === "consume" && input.amount > requestState.committed) throw new Error("Cannot consume more than this request has committed."); if (input.type === "release" && input.amount > requestState.reserved + requestState.committed) throw new Error("Cannot release more than this request has outstanding."); if (input.type === "refund" && input.amount > requestState.consumed) throw new Error("Cannot refund more than this request has consumed.");
  const event: LedgerEvent = { ...input, id: nextId("L", workspace.ledger), createdAt: new Date().toISOString() }; const updated = copy(workspace); updated.ledger = [...updated.ledger, event]; return { workspace: updated, event, duplicate: false };
}
export function reconcileResourceUsage(workspace: WorkspaceData, requestId: string, resourceId: string, actualUsage: number, actor: LedgerEvent["actor"], keyPrefix: string): WorkspaceData {
  if (workspace.executions.some((execution) => execution.requestId === requestId && execution.resourceId === resourceId && execution.status === "approved")) throw new Error("Resolve the approved external action first. Execute it, revoke it only if not invoked, or reconcile its result with GitHub before recording request usage.");
  const prefix = keyPrefix.trim(); if (!prefix) throw new Error("An idempotency key is required.");
  const reconciliationKeys = new Set(["reserve", "commit", "consume", "refund", "release"].map((suffix) => `${prefix}:${suffix}`));
  const priorEvents = workspace.ledger.filter((event) => reconciliationKeys.has(event.idempotencyKey));
  if (priorEvents.length) {
    const priorUsage = workspace.cases.find((item) => item.id === requestId)?.actualUsage[resourceId];
    if (priorEvents.every((event) => event.requestId === requestId && event.resourceId === resourceId && event.actor === actor) && priorUsage === actualUsage) return workspace;
    throw new Error("Idempotency key was already used for a different reconciliation.");
  }
  const allocation = allocateWorkspaceResources(workspace).allocations.find((item) => item.caseId === requestId)?.resources[resourceId];
  const inboxEntry = workspace.inbox?.find((item) => item.requestId === requestId && item.resourceId === resourceId);
  const inboxDecision = inboxEntry?.decision;
  if (inboxEntry && !inboxEntry.execution && !inboxDecision) throw new Error("Authorize incoming budget through the request inbox before reconciling usage.");
  const allocationLimit = inboxDecision ? inboxDecision.status === "approved" ? inboxDecision.amount : 0 : allocation?.allocated ?? 0;
  if (allocationLimit <= 0) throw new Error("The request has no allocation to reconcile.");
  if (!Number.isFinite(actualUsage) || actualUsage < 0 || actualUsage > allocationLimit) throw new Error("Actual usage must be between zero and the allocated amount.");
  let next = workspace; const resource = workspace.policy.resources.find((item) => item.id === resourceId)!;
  const perRequest = (value: WorkspaceData) => resourceLedgerState({ ...resource, capacity: Number.MAX_SAFE_INTEGER, reserve: 0 }, value.ledger.filter((event) => event.requestId === requestId && event.resourceId === resourceId));
  let state = perRequest(next);
  if (inboxDecision && actualUsage > state.reserved + state.committed + state.consumed) throw new Error("Usage exceeds the remaining authorization. Released budget cannot be reused without a new request.");
  if (Math.abs(state.consumed - actualUsage) <= 0.000001 && state.reserved + state.committed <= 0.000001) return workspace;
  const extraReservation = inboxDecision ? 0 : Math.max(0, allocationLimit - state.reserved - state.committed - state.consumed);
  if (extraReservation > 0) next = appendLedgerEvent(next, { idempotencyKey: `${prefix}:reserve`, requestId, resourceId, type: "reserve", amount: extraReservation, actor, note: "Reserved capacity required for actual usage." }).workspace;
  state = perRequest(next); const commitAmount = Math.min(state.reserved, Math.max(0, actualUsage - state.consumed - state.committed));
  if (commitAmount > 0) next = appendLedgerEvent(next, { idempotencyKey: `${prefix}:commit`, requestId, resourceId, type: "commit", amount: commitAmount, actor, note: "Committed for execution." }).workspace;
  state = perRequest(next); const consumeAmount = Math.min(state.committed, Math.max(0, actualUsage - state.consumed));
  if (consumeAmount > 0) next = appendLedgerEvent(next, { idempotencyKey: `${prefix}:consume`, requestId, resourceId, type: "consume", amount: consumeAmount, actor, note: "Recorded actual usage." }).workspace;
  state = perRequest(next); const refundAmount = Math.max(0, state.consumed - actualUsage);
  if (refundAmount > 0) next = appendLedgerEvent(next, { idempotencyKey: `${prefix}:refund`, requestId, resourceId, type: "refund", amount: refundAmount, actor, note: "Corrected previously recorded usage." }).workspace;
  state = perRequest(next); if (state.reserved + state.committed > 0) next = appendLedgerEvent(next, { idempotencyKey: `${prefix}:release`, requestId, resourceId, type: "release", amount: state.reserved + state.committed, actor, note: "Released unused capacity." }).workspace;
  state = perRequest(next); if (Math.abs(state.consumed - actualUsage) > 0.000001) throw new Error("Usage reconciliation could not be completed without exceeding confirmed capacity.");
  next = copy(next); next.cases = next.cases.map((item) => item.id === requestId ? { ...item, actualUsage: { ...item.actualUsage, [resourceId]: state.consumed } } : item); return next;
}

export const EXTERNAL_ACTIONS: Record<ExternalActionId, { label: string; server: "github"; tool: ExternalExecution["tool"]; requiredArguments: string[]; optionalArguments: string[] }> = {
  "github.issue.add_labels": {
    label: "Apply labels to GitHub issue",
    server: "github",
    tool: "github_add_issue_labels",
    requiredArguments: ["repository_full_name", "issue_number", "labels"],
    optionalArguments: [],
  },
  "github.issue.add_comment": {
    label: "Post comment to GitHub issue",
    server: "github",
    tool: "github_add_comment_to_issue",
    requiredArguments: ["repo_full_name", "pr_number", "comment"],
    optionalArguments: [],
  },
  "github.pull_request.merge": {
    label: "Merge GitHub pull request",
    server: "github",
    tool: "github_merge_pull_request",
    requiredArguments: ["repository_full_name", "pr_number", "expected_head_sha"],
    optionalArguments: ["merge_method", "commit_title", "commit_message"],
  },
  "github.copilot.assign_issue": {
    label: "Assign GitHub Copilot to issue",
    server: "github",
    tool: "assign_copilot_to_issue",
    requiredArguments: ["owner", "repo", "issue_number"],
    optionalArguments: ["base_ref", "custom_instructions"],
  },
};

// Copilot assignment is retained for previously saved execution evidence, but
// new proposals use only actions exposed by the connected GitHub MCP surface.
export const PROPOSABLE_EXTERNAL_ACTIONS = ["github.issue.add_labels", "github.issue.add_comment", "github.pull_request.merge"] as const satisfies readonly ExternalActionId[];

export interface ExternalExecutionProposalInput {
  requestId: string;
  actionId: ExternalActionId;
  arguments: Record<string, unknown>;
  resourceId: string;
  authorizedAmount: number;
  idempotencyKey: string;
  sourceFingerprint?: string;
}

export interface ExternalExecutionReceiptInput {
  status: "succeeded" | "failed";
  externalReference: string;
  resultUrl?: string;
  summary: string;
  actualUsage?: number;
}

function stableValue(value: ExternalActionArgument): string {
  return Array.isArray(value) ? `[${value.map((item) => JSON.stringify(item)).join(",")}]` : JSON.stringify(value);
}

function executionFingerprint(actionId: ExternalActionId, args: Record<string, ExternalActionArgument>): string {
  const serialized = `${actionId}|${Object.keys(args).sort().map((key) => `${key}:${stableValue(args[key])}`).join("|")}`;
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) { hash ^= serialized.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function githubName(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(value)) throw new Error(`${label} must be a valid GitHub owner or repository name.`);
  return value;
}

export function normalizeExternalActionArguments(actionId: ExternalActionId, candidate: Record<string, unknown>): Record<string, ExternalActionArgument> {
  const definition = EXTERNAL_ACTIONS[actionId];
  if (!definition) throw new Error("External action is not allowed.");
  const allowed = new Set([...definition.requiredArguments, ...definition.optionalArguments]);
  const extras = Object.keys(candidate).filter((key) => !allowed.has(key));
  if (extras.length) throw new Error(`Unsupported external action arguments: ${extras.join(", ")}.`);
  for (const key of definition.requiredArguments) if (candidate[key] === undefined) throw new Error(`${key} is required for ${actionId}.`);
  const issueNumberKey = actionId === "github.issue.add_comment" || actionId === "github.pull_request.merge" ? "pr_number" : "issue_number";
  const issueNumber = candidate[issueNumberKey];
  if (!Number.isInteger(issueNumber) || Number(issueNumber) < 1 || Number(issueNumber) > 1_000_000_000) throw new Error(`${issueNumberKey} must be a positive integer.`);
  const normalized: Record<string, ExternalActionArgument> = { [issueNumberKey]: Number(issueNumber) };
  if (actionId === "github.issue.add_labels") {
    if (typeof candidate.repository_full_name !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(candidate.repository_full_name)) throw new Error("repository_full_name must use GitHub owner/repository format.");
    normalized.repository_full_name = candidate.repository_full_name;
    if (!Array.isArray(candidate.labels) || candidate.labels.length < 1 || candidate.labels.length > 10 || candidate.labels.some((label) => typeof label !== "string" || !label.trim() || label.length > 50)) throw new Error("labels must contain 1–10 non-empty GitHub label names.");
    normalized.labels = [...new Set(candidate.labels.map((label) => String(label).trim()))];
  } else if (actionId === "github.issue.add_comment") {
    if (typeof candidate.repo_full_name !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(candidate.repo_full_name)) throw new Error("repo_full_name must use GitHub owner/repository format.");
    normalized.repo_full_name = candidate.repo_full_name;
    if (typeof candidate.comment !== "string" || !candidate.comment.trim() || candidate.comment.length > 2_000) throw new Error("comment must be a non-empty string of at most 2,000 characters.");
    normalized.comment = candidate.comment.trim();
  } else if (actionId === "github.pull_request.merge") {
    if (typeof candidate.repository_full_name !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(candidate.repository_full_name)) throw new Error("repository_full_name must use GitHub owner/repository format.");
    normalized.repository_full_name = candidate.repository_full_name;
    if (typeof candidate.expected_head_sha !== "string" || !/^[a-fA-F0-9]{40,64}$/.test(candidate.expected_head_sha)) throw new Error("expected_head_sha must be the exact 40–64 character Git commit SHA inspected by the agent.");
    normalized.expected_head_sha = candidate.expected_head_sha.toLowerCase();
    if (candidate.merge_method !== undefined) {
      if (!(["merge", "squash", "rebase"] as const).includes(candidate.merge_method as "merge" | "squash" | "rebase")) throw new Error("merge_method must be merge, squash, or rebase.");
      normalized.merge_method = candidate.merge_method as string;
    }
    for (const key of ["commit_title", "commit_message"] as const) {
      const maximum = key === "commit_title" ? 200 : 2_000;
      if (candidate[key] !== undefined) {
        if (typeof candidate[key] !== "string" || !candidate[key].trim() || candidate[key].length > maximum) throw new Error(`${key} must be a non-empty string of at most ${maximum.toLocaleString("en-US")} characters.`);
        normalized[key] = candidate[key].trim();
      }
    }
  } else {
    normalized.owner = githubName(candidate.owner, "owner");
    normalized.repo = githubName(candidate.repo, "repo");
    if (candidate.base_ref !== undefined) {
      if (typeof candidate.base_ref !== "string" || !candidate.base_ref.trim() || candidate.base_ref.length > 200) throw new Error("base_ref must be a non-empty string of at most 200 characters.");
      normalized.base_ref = candidate.base_ref.trim();
    }
    if (candidate.custom_instructions !== undefined) {
      if (typeof candidate.custom_instructions !== "string" || !candidate.custom_instructions.trim() || candidate.custom_instructions.length > 500) throw new Error("custom_instructions must be a non-empty string of at most 500 characters.");
      normalized.custom_instructions = candidate.custom_instructions.trim();
    }
  }
  return normalized;
}

function executionProposalMatches(execution: ExternalExecution, input: ExternalExecutionProposalInput, args: Record<string, ExternalActionArgument>): boolean {
  return execution.requestId === input.requestId && execution.actionId === input.actionId && execution.resourceId === input.resourceId && execution.authorizedAmount === input.authorizedAmount && execution.argumentsFingerprint === executionFingerprint(input.actionId, args) && (execution.sourceFingerprint ?? null) === (input.sourceFingerprint ?? null);
}

export function proposeExternalExecution(workspace: WorkspaceData, input: ExternalExecutionProposalInput): { workspace: WorkspaceData; execution: ExternalExecution; duplicate: boolean } {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 120) throw new Error("An idempotency key of at most 120 characters is required.");
  const sourceFingerprint = input.sourceFingerprint?.trim().toLowerCase();
  if (sourceFingerprint !== undefined && !/^sha256-[a-f0-9]{64}$/.test(sourceFingerprint)) throw new Error("source_fingerprint must be a SHA-256 fingerprint of the inspected source intake.");
  const args = normalizeExternalActionArguments(input.actionId, input.arguments);
  const duplicate = workspace.executions.find((item) => item.idempotencyKey === idempotencyKey);
  if (duplicate) {
    if (!executionProposalMatches(duplicate, input, args)) throw new Error("Idempotency key was already used for a different external execution.");
    return { workspace, execution: duplicate, duplicate: true };
  }
  if (!(PROPOSABLE_EXTERNAL_ACTIONS as readonly ExternalActionId[]).includes(input.actionId)) throw new Error("That external action is retained only for historical evidence and cannot be proposed by the current connected MCP surface.");
  if (workspace.executions.length >= WORKSPACE_LIMITS.executions) throw new Error("External execution storage limit reached. Export this workspace before starting a new one.");
  const blockers = policyExecutionIssues(workspace.policy, workspace.rules, workspace.cases);
  if (blockers.length) throw new Error(`External execution requires an active policy with no blocking errors: ${blockers.map((issue) => issue.message).join(" ")}`);
  const request = workspace.cases.find((item) => item.id === input.requestId); if (!request) throw new Error("Request not found.");
  if (!request.source || request.source.system !== "github") throw new Error("External GitHub execution requires canonical GitHub source provenance on the request.");
  const repository = typeof args.repository_full_name === "string" ? args.repository_full_name : typeof args.repo_full_name === "string" ? args.repo_full_name : `${String(args.owner)}/${String(args.repo)}`;
  const issueNumber = args.issue_number ?? args.pr_number;
  const targetKind = input.actionId === "github.pull_request.merge" ? "pull" : "issues";
  const expectedSourceUrl = `https://github.com/${repository}/${targetKind}/${String(issueNumber)}`;
  if (request.source.url.replace(/\/$/, "").toLowerCase() !== expectedSourceUrl.toLowerCase()) throw new Error("External action target must match the request's canonical GitHub source URL.");
  const resource = workspace.policy.resources.find((item) => item.id === input.resourceId); if (!resource) throw new Error("Resource pool not found.");
  if (!Number.isFinite(input.authorizedAmount) || input.authorizedAmount <= 0) throw new Error("authorized_amount must be greater than zero.");
  if (resourceRequiresWholeUnits(resource) && !Number.isInteger(input.authorizedAmount)) throw new Error(`${resource.label} authorization must use whole ${resource.unit}.`);
  const portfolio = allocateWorkspaceResources(workspace);
  const evaluation = portfolio.evaluations.find((item) => item.caseId === request.id);
  if (evaluation?.outcome !== "eligible") throw new Error("Only eligible requests can be proposed for external execution.");
  const remaining = planWorkspaceBudget(workspace, resource.id).rows.find((item) => item.request.id === request.id)?.amount ?? 0;
  if (remaining <= 0) throw new Error("This request has no remaining policy allocation for the selected resource.");
  if (input.authorizedAmount > remaining + 0.000001) throw new Error("Authorization exceeds this request's remaining simulated allocation.");
  const policyVersion = workspace.versions.at(-1); if (!policyVersion) throw new Error("Save a policy version before proposing external execution.");
  const currentSnapshot = createSnapshot(workspace.policy, workspace.rules, workspace.cases);
  const policyComparison = compareSimulationSnapshots(policyVersion.snapshot, currentSnapshot);
  if (policyComparison.policyChanged || policyComparison.changedRules.length || policyComparison.changedRequests.length) throw new Error("The latest saved policy version does not match the active inputs. Save the current version before proposing external execution.");
  const definition = EXTERNAL_ACTIONS[input.actionId];
  const approvalRequired = governancePolicy(workspace.policy).requireApproval;
  const execution: ExternalExecution = {
    id: nextId("EX", workspace.executions), idempotencyKey, requestId: request.id, policyVersionId: policyVersion.id,
    actionId: input.actionId, server: definition.server, tool: definition.tool, arguments: args, argumentsFingerprint: executionFingerprint(input.actionId, args), ...(sourceFingerprint ? { sourceFingerprint } : {}),
    resourceId: resource.id, authorizedAmount: input.authorizedAmount, authorizationMode: approvalRequired ? "human_approval" : "policy_automatic", status: "pending_approval", proposedBy: "agent", proposedAt: new Date().toISOString(),
    approvedBy: null, approvedAt: null, receipt: null,
  };
  let next = copy(workspace); next.executions.push(execution);
  if (!approvalRequired) next = authorizeExternalExecution(next, execution.id, "Active policy", "policy_automatic");
  return { workspace: next, execution: next.executions.find((item) => item.id === execution.id)!, duplicate: false };
}

function authorizeExternalExecution(workspace: WorkspaceData, executionId: string, approvedBy: string, mode: ExternalAuthorizationMode): WorkspaceData {
  const execution = workspace.executions.find((item) => item.id === executionId); if (!execution) throw new Error("External execution not found.");
  if (execution.status !== "pending_approval") throw new Error("Only pending external executions can be approved.");
  if (!approvedBy.trim() || approvedBy.length > 120) throw new Error("An approver identity is required.");
  const version = workspace.versions.find((item) => item.id === execution.policyVersionId); if (!version) throw new Error("The pinned policy version no longer exists.");
  const comparison = compareSimulationSnapshots(version.snapshot, createSnapshot(workspace.policy, workspace.rules, workspace.cases));
  if (comparison.policyChanged || comparison.changedRules.length || comparison.changedRequests.length) throw new Error("Policy inputs changed after this execution was proposed. Reject it and ask the agent to propose again.");
  if (execution.authorizationMode !== mode) throw new Error(mode === "human_approval" ? "This execution is not waiting for human approval." : "This execution is not eligible for policy-authorized automation.");
  let next = appendLedgerEvent(workspace, { idempotencyKey: `${execution.idempotencyKey}:reserve`, requestId: execution.requestId, resourceId: execution.resourceId, type: "reserve", amount: execution.authorizedAmount, actor: mode === "human_approval" ? "human" : "engine", note: mode === "human_approval" ? `Reserved after human approval for external action ${execution.actionId}.` : `Reserved automatically under ${execution.policyVersionId} for external action ${execution.actionId}.` }).workspace;
  const approvedAt = new Date().toISOString(); next = copy(next); next.executions = next.executions.map((item) => item.id === executionId ? { ...item, status: "approved", approvedBy: approvedBy.trim(), approvedAt } : item); return next;
}

export function approveExternalExecution(workspace: WorkspaceData, executionId: string, approvedBy: string): WorkspaceData {
  return authorizeExternalExecution(workspace, executionId, approvedBy, "human_approval");
}

export function rejectExternalExecution(workspace: WorkspaceData, executionId: string): WorkspaceData {
  const execution = workspace.executions.find((item) => item.id === executionId); if (!execution) throw new Error("External execution not found.");
  if (execution.status !== "pending_approval") throw new Error("Only pending external executions can be rejected.");
  const next = copy(workspace); next.executions = next.executions.map((item) => item.id === executionId ? { ...item, status: "rejected" } : item); return next;
}

export function cancelExternalExecution(workspace: WorkspaceData, executionId: string, cancelledBy: string): WorkspaceData {
  const execution = workspace.executions.find((item) => item.id === executionId); if (!execution) throw new Error("External execution not found.");
  if (execution.attempt) throw new Error("An invoked action must be reconciled before its reservation can be released.");
  if (execution.status !== "approved") throw new Error("Only an approved external execution that has not recorded a result can be revoked.");
  if (!cancelledBy.trim() || cancelledBy.length > 120) throw new Error("A revoker identity is required.");
  let next = appendLedgerEvent(workspace, { idempotencyKey: `${execution.idempotencyKey}:cancel`, requestId: execution.requestId, resourceId: execution.resourceId, type: "release", amount: execution.authorizedAmount, actor: "human", note: `Approval for external action ${execution.actionId} revoked before a result was recorded.` }).workspace;
  const cancelledAt = new Date().toISOString(); next = copy(next); next.executions = next.executions.map((item) => item.id === executionId ? { ...item, status: "cancelled", cancelledBy: cancelledBy.trim(), cancelledAt } : item); return next;
}

function safeGithubResultUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com"; } catch { return false; }
}

export function githubRequestSourceIsCanonical(source: Pick<RequestSource, "externalId" | "url">): boolean {
  try {
    const url = new URL(source.url);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.search || url.hash) return false;
    const parts = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
    if (parts.length !== 4 || !["issues", "pull"].includes(parts[2]) || !/^[1-9]\d*$/.test(parts[3])) return false;
    return source.externalId.toLowerCase() === `${parts[0]}/${parts[1]}#${parts[3]}`.toLowerCase();
  } catch { return false; }
}

export function recordExternalExecution(workspace: WorkspaceData, executionId: string, input: ExternalExecutionReceiptInput): WorkspaceData {
  const execution = workspace.executions.find((item) => item.id === executionId); if (!execution) throw new Error("External execution not found.");
  if (!input.externalReference.trim() || input.externalReference.length > 200) throw new Error("external_reference is required and must be at most 200 characters.");
  if (!input.summary.trim() || input.summary.length > 240) throw new Error("summary is required and must be at most 240 characters.");
  if (input.resultUrl !== undefined && !safeGithubResultUrl(input.resultUrl)) throw new Error("result_url must be an https://github.com URL.");
  const resource = workspace.policy.resources.find((item) => item.id === execution.resourceId); if (!resource) throw new Error("Resource pool not found.");
  if (input.actualUsage !== undefined && (!Number.isFinite(input.actualUsage) || input.actualUsage < 0 || input.actualUsage > execution.authorizedAmount)) throw new Error("actual_usage must be between zero and the approved external authorization.");
  if (input.actualUsage !== undefined && input.status !== "succeeded") throw new Error("actual_usage can be recorded only for a successful external execution.");
  if (input.actualUsage !== undefined && resourceRequiresWholeUnits(resource) && !Number.isInteger(input.actualUsage)) throw new Error(`${resource.label} actual usage must use whole ${resource.unit}.`);
  const externalReference = input.externalReference.trim(), summary = input.summary.trim();
  const sameCoreReceipt = Boolean(execution.receipt && execution.receipt.status === input.status && execution.receipt.externalReference === externalReference && execution.receipt.resultUrl === input.resultUrl && execution.receipt.summary === summary);
  if (execution.receipt) {
    if (sameCoreReceipt && execution.receipt.actualUsage === input.actualUsage) return workspace;
    if (!sameCoreReceipt || execution.status !== "succeeded" || execution.receipt.actualUsage !== undefined || input.actualUsage === undefined) throw new Error("This external execution already has a different receipt.");
  }
  if (!execution.receipt && execution.status !== "approved") throw new Error("Only an authorized external execution can receive a result.");
  let next = workspace;
  if (!execution.receipt) {
    const type: LedgerEventType = input.status === "succeeded" ? "commit" : "release";
    next = appendLedgerEvent(next, { idempotencyKey: `${execution.idempotencyKey}:${type}`, requestId: execution.requestId, resourceId: execution.resourceId, type, amount: execution.authorizedAmount, actor: "agent", note: input.status === "succeeded" ? `External action ${execution.actionId} succeeded.` : `External action ${execution.actionId} failed; reservation released.` }).workspace;
  }
  if (input.status === "succeeded" && input.actualUsage !== undefined) {
    if (input.actualUsage > 0) next = appendLedgerEvent(next, { idempotencyKey: `${execution.idempotencyKey}:consume`, requestId: execution.requestId, resourceId: execution.resourceId, type: "consume", amount: input.actualUsage, actor: "agent", note: `Provider-reported usage for external action ${execution.actionId}.` }).workspace;
    const unused = execution.authorizedAmount - input.actualUsage;
    if (unused > 0) next = appendLedgerEvent(next, { idempotencyKey: `${execution.idempotencyKey}:usage-release`, requestId: execution.requestId, resourceId: execution.resourceId, type: "release", amount: unused, actor: "agent", note: `Released unused authorization for external action ${execution.actionId}.` }).workspace;
    const requestState = resourceLedgerState({ ...resource, capacity: Number.MAX_SAFE_INTEGER, reserve: 0 }, next.ledger.filter((event) => event.requestId === execution.requestId && event.resourceId === execution.resourceId));
    next = copy(next); next.cases = next.cases.map((item) => item.id === execution.requestId ? { ...item, actualUsage: { ...item.actualUsage, [execution.resourceId]: requestState.consumed } } : item);
  }
  const receipt: ExternalExecutionReceipt = { status: input.status, externalReference, ...(input.resultUrl ? { resultUrl: input.resultUrl } : {}), summary, ...(input.actualUsage === undefined ? {} : { actualUsage: input.actualUsage }), recordedAt: execution.receipt?.recordedAt ?? new Date().toISOString() };
  next = copy(next); next.executions = next.executions.map((item) => item.id === executionId ? { ...item, status: input.status, receipt } : item); return next;
}

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown, min = 0, max = 100_000_000): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const nonEmpty = (value: unknown, max = 300): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= max;
const timestamp = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const unique = (values: string[]): boolean => new Set(values.map((value) => value.trim().toLowerCase())).size === values.length;
function validPolicy(candidate: unknown, allowUnconfiguredRateWindow = false): candidate is Policy {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const policy = candidate as Policy;
  const outcomeRecord = record(policy.outcomes);
  if (!nonEmpty(policy.name, 100) || !nonEmpty(policy.objective, 300) || !outcomeRecord || ![outcomeRecord.eligible, outcomeRecord.boundary, outcomeRecord.review].every((value) => nonEmpty(value, 40))) return false;
  if (policy.boundary !== undefined && (!record(policy.boundary) || !finite(policy.boundary.tolerance, 0, 1) || !Number.isInteger(policy.boundary.maximumFailedRules) || !finite(policy.boundary.maximumFailedRules, 0, 10))) return false;
  if (policy.scoring !== undefined && (!record(policy.scoring) || !finite(policy.scoring.minimum, -100_000_000) || !finite(policy.scoring.maximum, -100_000_000) || policy.scoring.minimum > policy.scoring.maximum || !finite(policy.scoring.base, policy.scoring.minimum, policy.scoring.maximum))) return false;
  if (policy.governance !== undefined) { const governance = policy.governance; if (!record(governance) || !nonEmpty(governance.owner, 100) || !["draft", "active", "retired"].includes(governance.status) || typeof governance.requireApproval !== "boolean" || typeof governance.requireRationale !== "boolean" || (governance.effectiveFrom !== undefined && !timestamp(governance.effectiveFrom)) || (governance.effectiveUntil !== undefined && !timestamp(governance.effectiveUntil)) || (governance.effectiveFrom && governance.effectiveUntil && Date.parse(governance.effectiveFrom) > Date.parse(governance.effectiveUntil))) return false; }
  if (!Array.isArray(policy.fields) || !policy.fields.length || policy.fields.length > WORKSPACE_LIMITS.fields || !unique(policy.fields.map((field) => field.key))) return false;
  if (!policy.fields.every((field) => nonEmpty(field.key, 40) && nonEmpty(field.label, 80) && ["number", "integer", "enum", "boolean"].includes(field.type) && (field.min === undefined || finite(field.min, -100_000_000)) && (field.max === undefined || finite(field.max, -100_000_000)) && (field.min === undefined || field.max === undefined || field.min <= field.max) && (field.type !== "enum" || (Array.isArray(field.options) && field.options.length > 0 && field.options.length <= 30 && field.options.every((option) => nonEmpty(option, 80)) && unique(field.options))))) return false;
  if (!Array.isArray(policy.resources) || !policy.resources.length || policy.resources.length > WORKSPACE_LIMITS.resources || !unique(policy.resources.map((resource) => resource.id))) return false;
  if (!policy.resources.every((resource) => nonEmpty(resource.id, 40) && nonEmpty(resource.label, 80) && nonEmpty(resource.unit, 30) && finite(resource.capacity) && finite(resource.reserve) && resource.reserve <= resource.capacity && typeof resource.divisible === "boolean" && ["priority_first_fit", "partial", "proportional", "weighted_fair", "slot", "rate_limit"].includes(resource.strategy) && (!resourceRequiresWholeUnits(resource) || Number.isInteger(resource.capacity) && Number.isInteger(resource.reserve)) && (resource.strategy !== "rate_limit" || finite(resource.windowSeconds, 1, 31_536_000) || allowUnconfiguredRateWindow && resource.windowSeconds === undefined))) return false;
  if (!policy.resources.some((resource) => resource.id === policy.primaryResourceId) || !Array.isArray(policy.ranking) || !policy.ranking.length || policy.ranking.length > 10) return false;
  return policy.ranking.every((item) => ["score", "field", "demand"].includes(item.source) && ["asc", "desc"].includes(item.direction) && (item.source === "score" || (nonEmpty(item.key, 40) && (item.source === "field" ? policy.fields.some((field) => field.key === item.key) : policy.resources.some((resource) => resource.id === item.key)))));
}
export const policyIsValid = (candidate: unknown): candidate is Policy => validPolicy(candidate);
export function validCase(item: TestCase, policy: Policy): boolean {
  if (!nonEmpty(item.id, 20) || !nonEmpty(item.name, 100) || !record(item.values) || !record(item.demands) || !record(item.minimums) || !record(item.actualUsage)) return false;
  if (item.group !== undefined && (typeof item.group !== "string" || item.group.length > 80)) return false;
  if (item.source !== undefined && (!record(item.source) || item.source.system !== "github" || !nonEmpty(item.source.externalId, 160) || !githubRequestSourceIsCanonical(item.source) || !timestamp(item.source.importedAt))) return false;
  const fieldKeys = policy.fields.map((field) => field.key); const resourceIds = policy.resources.map((resource) => resource.id);
  if (Object.keys(item.values).some((key) => !fieldKeys.includes(key)) || [...Object.keys(item.demands), ...Object.keys(item.minimums), ...Object.keys(item.actualUsage)].some((key) => !resourceIds.includes(key))) return false;
  for (const field of policy.fields) { const value = item.values[field.key]; if (value === undefined) return false; if ((field.type === "number" || field.type === "integer") && (!finite(value, field.min ?? -100_000_000, field.max ?? 100_000_000) || (field.type === "integer" && !Number.isInteger(value)))) return false; if (field.type === "boolean" && typeof value !== "boolean") return false; if (field.type === "enum" && !field.options?.includes(String(value))) return false; }
  return policy.resources.every((resource) => {
    const demand = item.demands[resource.id] ?? 0, minimum = item.minimums[resource.id] ?? 0, actual = item.actualUsage[resource.id] ?? 0;
    return finite(demand) && finite(minimum) && finite(actual) && minimum <= demand && actual <= demand && (!resourceRequiresWholeUnits(resource) || Number.isInteger(demand) && Number.isInteger(minimum) && Number.isInteger(actual));
  });
}
function normalizedCase(item: TestCase): TestCase {
  return { id: item.id, name: item.name, values: { ...item.values }, demands: { ...item.demands }, minimums: { ...item.minimums }, actualUsage: { ...item.actualUsage }, ...(item.group ? { group: item.group } : {}), ...(item.source ? { source: { ...item.source } } : {}) };
}
function normalizedSnapshot(snapshot: SimulationSnapshot): SimulationSnapshot {
  return { policy: copy(snapshot.policy), rules: copy(snapshot.rules), cases: snapshot.cases.map(normalizedCase) };
}
const validRule = (rule: PolicyRule, policy: Policy): boolean => nonEmpty(rule.id, 20) && nonEmpty(rule.label, 80) && typeof rule.enabled === "boolean" && ["all", "any"].includes(rule.match) && ["threshold", "score", "outcome", "cap"].includes(rule.kind) && Number.isFinite(rule.priority) && validateRule(rule, policy).length === 0;
const validSnapshot = (value: SimulationSnapshot): boolean => Boolean(value && validPolicy(value.policy) && Array.isArray(value.rules) && value.rules.length <= WORKSPACE_LIMITS.rules && value.rules.every((rule) => validRule(rule, value.policy)) && unique(value.rules.map((rule) => rule.id)) && Array.isArray(value.cases) && value.cases.length <= WORKSPACE_LIMITS.cases && value.cases.every((item) => validCase(item, value.policy)) && unique(value.cases.map((item) => item.id)) && unique(value.cases.map((item) => item.name)));
function migrateLegacy(value: Record<string, unknown>): WorkspaceData | null {
  const legacyPolicy = record(value.policy); if (!legacyPolicy || !nonEmpty(legacyPolicy.name, 100) || !nonEmpty(legacyPolicy.objective, 300) || !finite(legacyPolicy.budget)) return null;
  const outcomes = record(legacyPolicy.outcomes);
  const policy: Policy = {
    name: legacyPolicy.name,
    objective: legacyPolicy.objective,
    outcomes: outcomes && nonEmpty(outcomes.eligible, 40) && nonEmpty(outcomes.boundary, 40) && nonEmpty(outcomes.review, 40)
      ? outcomes as unknown as OutcomeLabels
      : { ...defaultOutcomeLabels },
    fields: [
      { key: "readiness", label: "Readiness score", type: "integer", min: 1, max: 5 },
      { key: "communityReach", label: "Community reach", type: "integer", unit: "people", min: 0 },
      { key: "urgency", label: "Urgency", type: "enum", options: ["low", "medium", "high"] },
    ],
    resources: [{ id: "funding", label: "Program funding", unit: "USD", capacity: legacyPolicy.budget, reserve: 0, strategy: "priority_first_fit", divisible: false }],
    primaryResourceId: "funding",
    ranking: [{ source: "score", direction: "desc" }, { source: "field", key: "communityReach", direction: "desc" }, { source: "demand", key: "funding", direction: "asc" }],
    boundary: { ...defaultBoundaryPolicy },
    scoring: { ...defaultScoringPolicy },
    governance: { ...defaultGovernancePolicy },
  };
  if (!Array.isArray(value.rules) || !Array.isArray(value.cases)) return null;
  const rules = value.rules.flatMap((candidate) => { const item = record(candidate); if (!item || !nonEmpty(item.id, 20) || !nonEmpty(item.label, 80) || !nonEmpty(item.field, 40) || !["lte", "gte", "eq"].includes(String(item.operator))) return []; const field = item.field === "requestedAmount" ? "demand:funding" : item.field; const kind = item.kind === "bonus" ? "score" : item.kind === "outcome" ? "outcome" : "threshold"; const rule: PolicyRule = { id: item.id, label: item.label, conditions: [{ field, operator: item.operator as Operator, value: item.value as FieldValue }], match: "all", kind, points: Number(item.points ?? 0), result: (item.result ?? null) as Outcome | null, resourceId: null, amount: 0, priority: 0, enabled: item.enabled !== false }; return validateRule(rule, policy).length ? [] : [rule]; });
  const cases = value.cases.flatMap((candidate) => { const item = record(candidate); if (!item || !nonEmpty(item.id, 20) || !nonEmpty(item.name, 100) || !finite(item.requestedAmount) || !finite(item.readiness, 1, 5) || !finite(item.communityReach) || !["low", "medium", "high"].includes(String(item.urgency))) return []; return [{ id: item.id, name: item.name, values: { readiness: item.readiness, communityReach: item.communityReach, urgency: item.urgency as string }, demands: { funding: item.requestedAmount }, minimums: { funding: item.requestedAmount }, actualUsage: {} }]; });
  if (rules.length !== value.rules.length || cases.length !== value.cases.length) return null;
  const activity = Array.isArray(value.activity) ? value.activity.filter((candidate): candidate is ActivityEvent => { const item = record(candidate); return Boolean(item && nonEmpty(item.id, 20) && ["human", "agent", "engine"].includes(String(item.actor)) && nonEmpty(item.action, 120) && typeof item.detail === "string" && item.detail.length <= 300 && timestamp(item.createdAt) && typeof item.undoable === "boolean"); }) : [];
  const versions: PolicyVersion[] = Array.isArray(value.versions) ? value.versions.flatMap((candidate) => { const item = record(candidate); if (!item || !nonEmpty(item.id, 20) || !nonEmpty(item.label, 60) || !nonEmpty(item.rationale, 240) || !timestamp(item.createdAt) || !Array.isArray(item.rules)) return []; const migrated = migrateLegacy({ policy: legacyPolicy, rules: item.rules, cases: value.cases, versions: [], activity: [] }); return migrated ? [{ id: item.id, label: item.label, rationale: item.rationale, createdAt: item.createdAt, snapshot: createSnapshot(policy, migrated.rules, cases) }] : []; }) : [];
  return { policy, rules, cases, versions, impactReports: [], activity, ledger: [], executions: [], presetId: "custom" };
}
export function safeWorkspace(candidate: unknown): WorkspaceData | null {
  const value = record(candidate); if (!value) return null; const policy = value.policy as Policy; const presetHint = typeof value.presetId === "string" ? value.presetId : ""; const incompleteTemplate = (presetHint === "unconfigured" || presetHint.startsWith("schema:")) && Array.isArray(value.rules) && value.rules.length === 0 && Array.isArray(value.cases) && value.cases.length === 0 && Array.isArray(value.versions) && value.versions.length === 0 && Array.isArray(value.ledger) && value.ledger.length === 0; if (!validPolicy(policy, incompleteTemplate)) return migrateLegacy(value);
  if (!Array.isArray(value.rules) || value.rules.length > WORKSPACE_LIMITS.rules || !value.rules.every((rule) => validRule(rule as PolicyRule, policy))) return null;
  if (!Array.isArray(value.cases) || value.cases.length > WORKSPACE_LIMITS.cases || !value.cases.every((item) => validCase(item as TestCase, policy))) return null;
  const rules = copy(value.rules as PolicyRule[]), cases = (value.cases as TestCase[]).map(normalizedCase); if (!unique(rules.map((rule) => rule.id)) || !unique(cases.map((item) => item.id)) || !unique(cases.map((item) => item.name))) return null;
  if (!Array.isArray(value.versions) || value.versions.length > WORKSPACE_LIMITS.versions || !value.versions.every((candidate) => { const item = candidate as PolicyVersion; return nonEmpty(item.id, 20) && nonEmpty(item.label, 60) && nonEmpty(item.rationale, 240) && timestamp(item.createdAt) && validSnapshot(item.snapshot); }) || !unique((value.versions as PolicyVersion[]).map((item) => item.id))) return null;
  const versions = (value.versions as PolicyVersion[]).map((item) => ({ ...item, snapshot: normalizedSnapshot(item.snapshot) })), versionIds = new Set(versions.map((item) => item.id));
  const rawImpactReports = Array.isArray(value.impactReports) ? value.impactReports as PolicyImpactReport[] : [];
  const impactReports = rawImpactReports.map((item) => {
    if (!item) return item;
    const approvedBy = item.approvedBy === undefined ? item.status === "approved" ? "Human reviewer" : null : item.approvedBy;
    if (item.rankChanges !== undefined) return { ...item, approvedBy };
    const rankChanges = Array.isArray(item.affectedCases) ? item.affectedCases.filter((delta) => delta.beforeRank !== delta.afterRank).length : 0;
    const allocationChanges = Array.isArray(item.affectedCases) ? item.affectedCases.filter((delta) => Array.isArray(delta.resources) && delta.resources.some((resource) => Math.abs(resource.delta) > 0.000001)).length : item.allocationChanges;
    return { ...item, approvedBy, rankChanges, allocationChanges };
  });
  if (impactReports.length > WORKSPACE_LIMITS.impactReports || !impactReports.every((item) => nonEmpty(item.id, 20) && nonEmpty(item.label, 100) && nonEmpty(item.rationale, 300) && (item.status === "approved" && nonEmpty(item.approvedBy, 120) || item.status === "applied" && item.approvedBy === null) && ["human", "agent"].includes(item.actor) && timestamp(item.createdAt) && (item.baselineVersionId === null || versionIds.has(item.baselineVersionId)) && versionIds.has(item.candidateVersionId) && typeof item.policyChanged === "boolean" && Array.isArray(item.changedRules) && item.changedRules.every((id) => nonEmpty(id, 20)) && unique(item.changedRules) && Array.isArray(item.changedRequests) && item.changedRequests.every((id) => nonEmpty(id, 20)) && unique(item.changedRequests) && Number.isInteger(item.outcomeChanges) && item.outcomeChanges >= 0 && Number.isInteger(item.rankChanges) && item.rankChanges >= 0 && Number.isInteger(item.allocationChanges) && item.allocationChanges >= 0 && Array.isArray(item.affectedCases) && item.affectedCases.length <= WORKSPACE_LIMITS.cases && unique(item.affectedCases.map((delta) => delta.caseId)) && item.affectedCases.every((delta) => nonEmpty(delta.caseId, 20) && nonEmpty(delta.name, 100) && ["eligible", "boundary", "review", "missing"].includes(delta.beforeOutcome) && ["eligible", "boundary", "review", "missing"].includes(delta.afterOutcome) && (delta.beforeRank === null || Number.isInteger(delta.beforeRank)) && (delta.afterRank === null || Number.isInteger(delta.afterRank)) && Array.isArray(delta.resources) && unique(delta.resources.map((resource) => resource.resourceId)) && delta.resources.every((resource) => nonEmpty(resource.resourceId, 40) && Number.isFinite(resource.before) && Number.isFinite(resource.after) && Number.isFinite(resource.delta))) && Array.isArray(item.resources) && unique(item.resources.map((resource) => resource.resourceId)) && item.resources.every((resource) => nonEmpty(resource.resourceId, 40) && Number.isFinite(resource.before) && Number.isFinite(resource.after) && Number.isFinite(resource.delta))) || !unique(impactReports.map((item) => item.id))) return null;
  if (!Array.isArray(value.activity) || value.activity.length > WORKSPACE_LIMITS.activity || !value.activity.every((candidate) => { const item = candidate as ActivityEvent; return nonEmpty(item.id, 20) && ["human", "agent", "engine"].includes(item.actor) && nonEmpty(item.action, 120) && typeof item.detail === "string" && item.detail.length <= 300 && timestamp(item.createdAt) && typeof item.undoable === "boolean" && (item.changeKind === undefined || item.changeKind === "workspace_replace"); }) || !unique((value.activity as ActivityEvent[]).map((item) => item.id))) return null;
  const ledger = Array.isArray(value.ledger) ? value.ledger as LedgerEvent[] : []; const requestIds = new Set(cases.map((item) => item.id)); const resourceIds = new Set(policy.resources.map((item) => item.id));
  if (ledger.length > WORKSPACE_LIMITS.ledger || !ledger.every((item) => nonEmpty(item.id, 20) && nonEmpty(item.idempotencyKey, 120) && requestIds.has(item.requestId) && resourceIds.has(item.resourceId) && ["reserve", "commit", "consume", "release", "refund"].includes(item.type) && finite(item.amount, 0.000001) && timestamp(item.createdAt) && ["human", "agent", "engine"].includes(item.actor) && typeof item.note === "string" && item.note.length <= 240) || !unique(ledger.map((item) => item.id)) || !unique(ledger.map((item) => item.idempotencyKey))) return null;
  const executions = Array.isArray(value.executions) ? (value.executions as ExternalExecution[]).map((item) => ({ ...item, authorizationMode: item.authorizationMode ?? "human_approval" })) : [];
  if (executions.length > WORKSPACE_LIMITS.executions || !unique(executions.map((item) => item.id)) || !unique(executions.map((item) => item.idempotencyKey)) || !executions.every((item) => {
    if (!nonEmpty(item.id, 20) || !nonEmpty(item.idempotencyKey, 120) || !requestIds.has(item.requestId) || !versionIds.has(item.policyVersionId) || !resourceIds.has(item.resourceId) || !Object.hasOwn(EXTERNAL_ACTIONS, item.actionId) || item.server !== "github" || !finite(item.authorizedAmount, 0.000001) || !["human_approval", "policy_automatic"].includes(item.authorizationMode) || !["pending_approval", "approved", "rejected", "cancelled", "succeeded", "failed"].includes(item.status) || item.proposedBy !== "agent" || !timestamp(item.proposedAt) || !record(item.arguments) || item.sourceFingerprint !== undefined && !/^sha256-[a-f0-9]{64}$/.test(item.sourceFingerprint)) return false;
    const definition = EXTERNAL_ACTIONS[item.actionId]; if (item.tool !== definition.tool) return false;
    if (item.attempt && (!nonEmpty(item.attempt.id, 80) || !timestamp(item.attempt.startedAt) || !["dispatching", "uncertain"].includes(item.attempt.state) || item.attempt.message !== undefined && !nonEmpty(item.attempt.message, 240))) return false;
    if (item.attempt && !["approved", "succeeded", "failed"].includes(item.status)) return false;
    if (item.budgetBinding && (!nonEmpty(item.budgetBinding.path, 240) || !nonEmpty(item.budgetBinding.pointer, 200) || !["total", "increase"].includes(item.budgetBinding.mode) || !/^[a-f0-9]{40,64}$/i.test(item.budgetBinding.baseSha) || !finite(item.budgetBinding.amount, 0.000001) || item.budgetBinding.amount !== item.authorizedAmount)) return false;
    let normalized: Record<string, ExternalActionArgument>; try { normalized = normalizeExternalActionArguments(item.actionId, item.arguments); } catch { return false; }
    if (JSON.stringify(normalized) !== JSON.stringify(item.arguments) || item.argumentsFingerprint !== executionFingerprint(item.actionId, normalized)) return false;
    const approved = item.status === "approved" || item.status === "cancelled" || item.status === "succeeded" || item.status === "failed";
    if (approved !== Boolean(nonEmpty(item.approvedBy, 120) && item.approvedAt && timestamp(item.approvedAt))) return false;
    if (!approved && (item.approvedBy !== null || item.approvedAt !== null)) return false;
    const cancelled = item.status === "cancelled";
    if (cancelled !== Boolean(nonEmpty(item.cancelledBy, 120) && item.cancelledAt && timestamp(item.cancelledAt))) return false;
    if (!cancelled && ((item.cancelledBy !== undefined && item.cancelledBy !== null) || (item.cancelledAt !== undefined && item.cancelledAt !== null))) return false;
    if ((item.status === "succeeded" || item.status === "failed") !== Boolean(item.receipt)) return false;
    if (item.receipt && (item.receipt.status !== item.status || !nonEmpty(item.receipt.externalReference, 200) || !nonEmpty(item.receipt.summary, 240) || !timestamp(item.receipt.recordedAt) || item.receipt.resultUrl !== undefined && !safeGithubResultUrl(item.receipt.resultUrl))) return false;
    if (item.receipt?.actualUsage !== undefined) {
      const resource = policy.resources.find((candidate) => candidate.id === item.resourceId); if (!resource || item.status !== "succeeded" || !finite(item.receipt.actualUsage, 0, item.authorizedAmount) || resourceRequiresWholeUnits(resource) && !Number.isInteger(item.receipt.actualUsage)) return false;
      const executionEvents = ledger.filter((event) => event.idempotencyKey.startsWith(`${item.idempotencyKey}:`)); const executionState = resourceLedgerState({ ...resource, capacity: Number.MAX_SAFE_INTEGER, reserve: 0 }, executionEvents);
      if (executionState.reserved > 0.000001 || executionState.committed > 0.000001 || Math.abs(executionState.consumed - item.receipt.actualUsage) > 0.000001) return false;
      if (item.receipt.actualUsage > 0 && !ledger.some((event) => event.idempotencyKey === `${item.idempotencyKey}:consume`)) return false;
      if (item.authorizedAmount - item.receipt.actualUsage > 0.000001 && !ledger.some((event) => event.idempotencyKey === `${item.idempotencyKey}:usage-release`)) return false;
    }
    if (approved && !ledger.some((event) => event.idempotencyKey === `${item.idempotencyKey}:reserve`)) return false;
    if (item.status === "succeeded" && !ledger.some((event) => event.idempotencyKey === `${item.idempotencyKey}:commit`)) return false;
    if (item.status === "failed" && !ledger.some((event) => event.idempotencyKey === `${item.idempotencyKey}:release`)) return false;
    if (item.status === "cancelled" && !ledger.some((event) => event.idempotencyKey === `${item.idempotencyKey}:cancel`)) return false;
    return true;
  })) return null;
  const batches = value.batches === undefined ? undefined : value.batches as RequestBatch[];
  if (batches !== undefined && (!Array.isArray(batches) || batches.length > 50 || !batches.every((batch) => Boolean(batch && typeof batch === "object")) || !unique(batches.map((batch) => batch.id)) || !batches.every((batch) => nonEmpty(batch.id, 20) && timestamp(batch.createdAt) && versionIds.has(batch.policyVersionId) && /^sha256-[a-f0-9]{64}$/.test(batch.portfolioFingerprint) && resourceIds.has(batch.resourceId) && nonEmpty(batch.unit, 40) && finite(batch.availableAtReview) && Array.isArray(batch.rows) && batch.rows.length >= 1 && batch.rows.length <= 5 && batch.rows.every((row) => Boolean(row && typeof row === "object")) && unique(batch.rows.map((row) => row.requestId)) && batch.rows.every((row) => nonEmpty(row.source, 220) && githubRequestSourceIsCanonical({ externalId: row.source, url: row.url }) && /^[a-f0-9]{40,64}$/i.test(row.headSha) && /^sha256-[a-f0-9]{64}$/.test(row.sourceFingerprint) && requestIds.has(row.requestId) && nonEmpty(row.name, 100) && ["eligible", "boundary", "review"].includes(row.outcome) && (row.rank === null || Number.isSafeInteger(row.rank) && row.rank > 0) && finite(row.simulated) && finite(row.authorization) && nonEmpty(row.reason, 300) && (row.executionId === null || executions.some((execution) => execution.id === row.executionId && execution.requestId === row.requestId)))))) return null;
  const inbox = value.inbox as InboxRequest[] | undefined;
  if (inbox !== undefined && (!Array.isArray(inbox) || inbox.length > WORKSPACE_LIMITS.cases || !inbox.every((item) => Boolean(record(item))) || !unique(inbox.map((item) => item.requestId)) || !unique(inbox.map((item) => item.submissionId)) || !inbox.every((item) => {
    if (!requestIds.has(item.requestId) || !nonEmpty(item.submissionId, 160) || !record(item.agent) || !nonEmpty(item.agent.id, 80) || !nonEmpty(item.agent.name, 80) || !record(item.source) || !/^[a-z][a-z0-9_-]{0,39}$/.test(item.source.system) || !nonEmpty(item.source.externalId, 160) || !resourceIds.has(item.resourceId) || !nonEmpty(item.reason, 500) || !timestamp(item.receivedAt) || !/^sha256-[a-f0-9]{64}$/.test(item.fingerprint)) return false;
    if (item.source.url !== undefined) { try { const url = new URL(item.source.url); if (url.protocol !== "https:" || url.username || url.password || item.source.url.length > 500) return false; } catch { return false; } }
    if (item.execution && (item.execution.adapter !== "github" || !nonEmpty(item.execution.reference, 240) || item.source.system !== "github" || !item.source.url || !githubRequestSourceIsCanonical({ externalId: item.source.externalId, url: item.source.url }))) return false;
    if (item.execution?.budget && (!nonEmpty(item.execution.budget.path, 240) || !nonEmpty(item.execution.budget.pointer, 200) || !["total", "increase"].includes(item.execution.budget.mode))) return false;
    const decision = item.decision;
    if (decision && (!record(decision) || !["approved", "rejected"].includes(decision.status) || !finite(decision.amount) || !nonEmpty(decision.by, 120) || !timestamp(decision.at) || !versionIds.has(decision.policyVersionId) || !nonEmpty(decision.rationale, 240) || !/^sha256-[a-f0-9]{64}$/.test(decision.reviewFingerprint))) return false;
    if (decision?.status === "approved" && (decision.amount <= 0 || item.execution || !ledger.some((event) => event.idempotencyKey === `inbox:${item.requestId}:reserve` && event.requestId === item.requestId && event.resourceId === item.resourceId && event.type === "reserve" && event.amount === decision.amount))) return false;
    if (decision?.status === "rejected" && decision.amount !== 0) return false;
    return true;
  }))) return null;
  const presetId = typeof value.presetId === "string" && value.presetId.length <= 80 ? value.presetId : "custom";
  return copy({ policy, rules, cases, versions, impactReports, activity: value.activity as ActivityEvent[], ledger, executions, ...(batches ? { batches } : {}), ...(inbox ? { inbox } : {}), presetId });
}
