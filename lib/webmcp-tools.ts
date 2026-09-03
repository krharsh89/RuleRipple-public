import { executionRequiresBuiltIn } from "./execution-state.ts";
import { externalExecutionAccounting } from "./execution-accounting.ts";
import { parseAgentRequest, requestInboxView, type AgentRequestInput } from "./request-inbox.ts";
import {
  allocationStrategyLabels,
  allocateWorkspaceResources,
  auditPolicy,
  boundaryPolicy,
  compareSimulationSnapshots,
  createSnapshot,
  evaluateAll,
  findBoundaryCases,
  githubRequestSourceIsCanonical,
  primaryResource,
  publicReviewerIdentity,
  governancePolicy,
  policyExecutionIssues,
  policyIsValid,
  PROPOSABLE_EXTERNAL_ACTIONS,
  resourceLedgerState,
  resourceRequiresWholeUnits,
  scoringPolicy,
  validateRule,
  WORKSPACE_LIMITS,
  type AllocationStrategy,
  type FieldValue,
  type FieldDefinition,
  type ExternalExecution,
  type ExternalExecutionProposalInput,
  type ExternalExecutionReceiptInput,
  type LedgerEvent,
  type Operator,
  type Outcome,
  type Policy,
  type PolicyRule,
  type RankingCriterion,
  type ResourcePool,
  type RequestSource,
  type RuleCondition,
  type RuleKind,
  type TestCase,
  type WorkspaceData,
} from "./domain.ts";
import { UNCONFIGURED_PRESET_ID, workspaceNeedsConfiguration } from "./presets.ts";

export interface ToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; untrustedContentHint?: boolean; }
export interface ModelContextTool { name: string; title: string; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations; execute: (input: Record<string, unknown>) => unknown | Promise<unknown>; }
export interface CaseInput extends Omit<TestCase, "id" | "actualUsage"> { id?: string; actualUsage?: Record<string, number>; }
export interface MutationResult<T> { value: T; status: "applied" | "pending_human_confirmation"; proposalId?: string; }
export interface WebMCPActions {
  submitBudgetRequests?: (requests: AgentRequestInput[]) => Promise<unknown>;
  createPolicy: (input: Policy, resetWorkspace: boolean) => MutationResult<Policy>;
  addRule: (input: Omit<PolicyRule, "id" | "enabled">) => MutationResult<PolicyRule>;
  updateRule: (id: string, patch: Partial<Omit<PolicyRule, "id">>) => MutationResult<PolicyRule> | null;
  requestRemoveRule: (id: string) => PolicyRule | null;
  upsertCases: (cases: CaseInput[]) => MutationResult<TestCase[]>;
  saveVersion: (label: string, rationale: string) => string;
  appendLedger: (input: Omit<LedgerEvent, "id" | "createdAt" | "actor">) => MutationResult<LedgerEvent>;
  reconcileUsage: (requestId: string, resourceId: string, actualUsage: number, idempotencyKey: string) => MutationResult<{ requestId: string; resourceId: string; actualUsage: number }>;
  proposeExternalExecution: (input: ExternalExecutionProposalInput) => MutationResult<ExternalExecution>;
  recordExternalExecution: (executionId: string, receipt: ExternalExecutionReceiptInput) => ExternalExecution;
}

function publicExternalExecution(execution: ExternalExecution): ExternalExecution {
  return {
    ...execution,
    approvedBy: publicReviewerIdentity(execution.approvedBy),
    cancelledBy: publicReviewerIdentity(execution.cancelledBy),
  };
}
export interface WebMCPConfig { getData: () => WorkspaceData; actions: WebMCPActions; }

const operators: Operator[] = ["lt", "lte", "gt", "gte", "eq", "neq", "in", "not_in", "between"];
const kinds: RuleKind[] = ["threshold", "score", "outcome", "cap"];
const outcomes: Outcome[] = ["eligible", "boundary", "review"];
const strategies: AllocationStrategy[] = ["priority_first_fit", "partial", "proportional", "weighted_fair", "slot", "rate_limit"];

function record(input: unknown): Record<string, unknown> { if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an object input."); return input as Record<string, unknown>; }
function requiredString(value: unknown, name: string, max = 120) { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`); const trimmed = value.trim(); if (trimmed.length > max) throw new Error(`${name} must be at most ${max} characters.`); return trimmed; }
function optionalString(value: unknown, name: string, max = 120) { return value === undefined || value === null ? undefined : requiredString(value, name, max); }
function requiredNumber(value: unknown, name: string, min = 0, max = 100_000_000) { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number between ${min} and ${max}.`); return value; }
function requiredBoolean(value: unknown, name: string) { if (typeof value !== "boolean") throw new Error(`${name} must be boolean.`); return value; }
function enumValue<T extends string>(value: unknown, name: string, allowed: readonly T[]) { if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${name} must be one of: ${allowed.join(", ")}.`); return value as T; }
function objectSchema(properties: Record<string, unknown>, required: string[] = [], additionalProperties = false) { return { type: "object", properties, required, additionalProperties }; }
export function toolResponse(value: unknown, isError = false) { const serialized = JSON.stringify(value); const text = serialized.length <= 3950 ? serialized : JSON.stringify({ truncated: true, original_length: serialized.length, preview: serialized.slice(0, 3500) }); return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) }; }
function safeExecute(handler: (input: Record<string, unknown>) => unknown | Promise<unknown>) { return async (input: Record<string, unknown>) => { try { return toolResponse(await handler(record(input))); } catch (error) { return toolResponse({ error: error instanceof Error ? error.message : "Tool execution failed." }, true); } }; }
function assertExecutionReady(data: WorkspaceData) { const issues = policyExecutionIssues(data.policy, data.rules, data.cases); if (issues.length) throw new Error(`Resource execution is blocked: ${issues.map((issue) => issue.message).join(" ")}`); }
function assertPolicyConfigured(data: WorkspaceData) { if (workspaceNeedsConfiguration(data)) throw new Error("Policy configuration is required first. Use create_policy with explicit policy inputs before adding rules, requests, or evaluating decisions."); }
function pageInput(input: Record<string, unknown>, total: number, defaultLimit = 3, maximumLimit = 10) {
  const offset = input.offset === undefined ? 0 : requiredNumber(input.offset, "offset", 0, Math.max(total, 100));
  const limit = input.limit === undefined ? defaultLimit : requiredNumber(input.limit, "limit", 1, maximumLimit);
  if (!Number.isInteger(offset) || !Number.isInteger(limit)) throw new Error("offset and limit must be integers.");
  return { offset, limit, nextOffset: offset + limit < total ? offset + limit : null };
}

function fieldValue(value: unknown): FieldValue | FieldValue[] {
  if (Array.isArray(value)) {
    if (!value.length || value.length > 20 || value.some((item) => !["string", "number", "boolean"].includes(typeof item))) throw new Error("Condition value lists must contain 1–20 scalar values.");
    return value as FieldValue[];
  }
  if (!["string", "number", "boolean"].includes(typeof value)) throw new Error("Condition values must be strings, numbers, booleans, or lists of them.");
  return value as FieldValue;
}

function parseCondition(input: unknown): RuleCondition {
  const value = record(input);
  return { field: requiredString(value.field, "condition field", 40), operator: enumValue(value.operator, "condition operator", operators), value: fieldValue(value.value) };
}

function parseRuleInput(input: Record<string, unknown>, policy: Policy, existing?: PolicyRule): Omit<PolicyRule, "id" | "enabled"> {
  const conditions = input.conditions === undefined
    ? existing?.conditions ?? [parseCondition({ field: input.field, operator: input.operator, value: input.value })]
    : Array.isArray(input.conditions) ? input.conditions.map(parseCondition) : (() => { throw new Error("conditions must be an array."); })();
  const kind = input.kind === undefined && existing ? existing.kind : enumValue(input.kind, "kind", kinds);
  const result = kind === "outcome" ? enumValue(input.result ?? existing?.result, "result", outcomes) : null;
  const resourceId = kind === "cap" ? requiredString(input.resource_id ?? existing?.resourceId, "resource_id", 40) : null;
  const rule = {
    label: input.label === undefined && existing ? existing.label : requiredString(input.label, "label", 80),
    conditions,
    match: input.match === undefined ? existing?.match ?? "all" : enumValue(input.match, "match", ["all", "any"] as const),
    kind,
    points: kind === "score" ? requiredNumber(input.points ?? existing?.points, "points", -100, 100) : 0,
    result,
    resourceId,
    amount: kind === "cap" ? requiredNumber(input.amount ?? existing?.amount, "amount") : 0,
    priority: input.priority === undefined ? existing?.priority ?? 0 : requiredNumber(input.priority, "priority", 0, 1000),
  };
  const errors = validateRule({ ...rule, id: existing?.id ?? "pending", enabled: existing?.enabled ?? true }, policy);
  if (errors.length) throw new Error(errors.join(" "));
  return rule;
}

function numericMap(value: unknown, name: string, knownKeys: string[], requiredKeys = knownKeys): Record<string, number> {
  const source = record(value); const result: Record<string, number> = {};
  for (const key of Object.keys(source)) { if (!knownKeys.includes(key)) throw new Error(`${name}.${key} is not a configured resource.`); result[key] = requiredNumber(source[key], `${name}.${key}`); }
  for (const key of requiredKeys) result[key] ??= 0;
  return result;
}

function parseRequestSource(input: unknown): RequestSource {
  const value = record(input); const system = enumValue(value.system, "source.system", ["github"] as const);
  const url = requiredString(value.url, "source.url", 300);
  const importedAt = value.imported_at === undefined ? new Date().toISOString() : requiredString(value.imported_at, "source.imported_at", 40);
  if (!Number.isFinite(Date.parse(importedAt))) throw new Error("source.imported_at must be a valid timestamp.");
  const source = { system, externalId: requiredString(value.external_id, "source.external_id", 160), url, importedAt };
  if (!githubRequestSourceIsCanonical(source)) throw new Error("source.external_id must match the canonical GitHub issue or pull-request URL as owner/repo#number.");
  return source;
}

function parseCase(input: unknown, data: WorkspaceData): CaseInput {
  assertPolicyConfigured(data);
  const value = record(input); const values = record(value.values); const parsedValues: Record<string, FieldValue> = {};
  const fieldKeys = data.policy.fields.map((field) => field.key); const unknownFields = Object.keys(values).filter((key) => !fieldKeys.includes(key)); if (unknownFields.length) throw new Error(`Unknown request fields: ${unknownFields.join(", ")}.`);
  for (const field of data.policy.fields) {
    const candidate = values[field.key];
    if (candidate === undefined) throw new Error(`values.${field.key} is required.`);
    if (field.type === "number" || field.type === "integer") { const numeric = requiredNumber(candidate, `values.${field.key}`, field.min ?? -100_000_000, field.max ?? 100_000_000); if (field.type === "integer" && !Number.isInteger(numeric)) throw new Error(`values.${field.key} must be an integer.`); parsedValues[field.key] = numeric; }
    else if (field.type === "boolean") { if (typeof candidate !== "boolean") throw new Error(`values.${field.key} must be boolean.`); parsedValues[field.key] = candidate; }
    else parsedValues[field.key] = enumValue(candidate, `values.${field.key}`, field.options ?? []);
  }
  const resourceIds = data.policy.resources.map((resource) => resource.id); const demands = numericMap(value.demands, "demands", resourceIds); const minimums = value.minimums === undefined ? { ...demands } : numericMap(value.minimums, "minimums", resourceIds);
  for (const resource of data.policy.resources) {
    if (resourceRequiresWholeUnits(resource) && (!Number.isInteger(demands[resource.id]) || !Number.isInteger(minimums[resource.id]))) throw new Error(`${resource.label} demand and minimum must use whole ${resource.unit}.`);
  }
  for (const id of resourceIds) if (minimums[id] > demands[id]) throw new Error(`minimums.${id} cannot exceed demand.`);
  if (!resourceIds.some((id) => demands[id] > 0)) throw new Error("At least one resource demand must be greater than zero.");
  return { id: optionalString(value.case_id, "case_id", 20), name: requiredString(value.name, "name", 100), values: parsedValues, demands, minimums, actualUsage: {}, group: optionalString(value.group, "group", 80), ...(value.source === undefined ? {} : { source: parseRequestSource(value.source) }) };
}

function parseFieldDefinition(input: unknown): FieldDefinition {
  const value = record(input); const type = enumValue(value.type, "field.type", ["number", "integer", "enum", "boolean"] as const);
  const options = value.options === undefined ? undefined : Array.isArray(value.options) ? value.options.map((option) => requiredString(option, "field option", 80)) : (() => { throw new Error("field.options must be an array."); })();
  return { key: requiredString(value.key, "field.key", 40), label: requiredString(value.label, "field.label", 80), type, ...(value.unit === undefined ? {} : { unit: requiredString(value.unit, "field.unit", 30) }), ...(value.min === undefined ? {} : { min: requiredNumber(value.min, "field.min", -100_000_000) }), ...(value.max === undefined ? {} : { max: requiredNumber(value.max, "field.max", -100_000_000) }), ...(options === undefined ? {} : { options }) };
}

function parseResourcePool(input: unknown): ResourcePool {
  const value = record(input); const strategy = enumValue(value.strategy, "resource.strategy", strategies);
  return { id: requiredString(value.id, "resource.id", 40), label: requiredString(value.label, "resource.label", 80), unit: requiredString(value.unit, "resource.unit", 30), capacity: requiredNumber(value.capacity, "resource.capacity"), reserve: requiredNumber(value.reserve, "resource.reserve"), strategy, divisible: requiredBoolean(value.divisible, "resource.divisible"), ...(value.window_seconds === undefined ? {} : { windowSeconds: requiredNumber(value.window_seconds, "resource.window_seconds", 1, 31_536_000) }) };
}

function parseRankingCriterion(input: unknown): RankingCriterion {
  const value = record(input); const source = enumValue(value.source, "ranking.source", ["score", "field", "demand"] as const);
  return { source, direction: enumValue(value.direction, "ranking.direction", ["asc", "desc"] as const), ...(source === "score" ? {} : { key: requiredString(value.key, "ranking.key", 40) }) };
}

export function createWebMCPTools(getConfig: () => WebMCPConfig): ModelContextTool[] {
  return [
    {
      name: "submit_budget_requests", title: "Submit agent budget requests", description: "Deliver source-neutral incoming requests to the shared inbox. No source URL is required. Caller-supplied decisions are rejected; policy controls authorization and human approval. Does not invoke external actions.",
      inputSchema: objectSchema({ requests: { type: "array", minItems: 1, maxItems: 25, items: objectSchema({ submission_id: { type: "string" }, agent: objectSchema({ id: { type: "string" }, name: { type: "string" } }, ["id", "name"]), source: objectSchema({ system: { type: "string" }, external_id: { type: "string" }, url: { type: "string" } }, ["system", "external_id"]), name: { type: "string" }, reason: { type: "string" }, resource_id: { type: "string" }, requested: { type: "number", exclusiveMinimum: 0 }, minimum: { type: "number", minimum: 0 }, values: objectSchema({}, [], true), execution: objectSchema({ adapter: { type: "string", enum: ["github"] }, reference: { type: "string" }, budget: objectSchema({ path: { type: "string" }, pointer: { type: "string" }, mode: { type: "string", enum: ["total", "increase"] } }, ["path", "pointer", "mode"]) }, ["adapter", "reference"]) }, ["submission_id", "agent", "source", "name", "reason", "resource_id", "requested", "minimum", "values"]) } }, ["requests"]),
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: safeExecute(async (input) => { const config = getConfig(); assertPolicyConfigured(config.getData()); if (!Array.isArray(input.requests) || input.requests.length < 1 || input.requests.length > 25) throw new Error("Submit 1–25 requests."); if (!config.actions.submitBudgetRequests) throw new Error("Request intake is unavailable in this context."); const result = record(await config.actions.submitBudgetRequests(input.requests.map((item) => parseAgentRequest(item, config.getData())))); return JSON.stringify(result).length <= 3800 ? result : { received: result.received, duplicates: result.duplicates, next_step: "Use get_request_inbox to read paginated decisions." }; }),
    },
    {
      name: "get_request_inbox", title: "Read incoming budget decisions", description: "Read agent requests, current policy allocation and authorization status without changing anything. Submission identity is declared by the workspace-authorized caller.",
      inputSchema: objectSchema({ request_id: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 5 } }), annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: safeExecute(async (input) => { const view = await requestInboxView(getConfig().getData()); const rows = input.request_id ? view.rows.filter((row) => row.requestId === requiredString(input.request_id, "request_id", 20)) : view.rows; const page = pageInput(input, rows.length, 3, 5); const requests = rows.slice(page.offset, page.offset + page.limit).map(({ trace, ...row }) => { void trace; return row; }); const result = { approval_required: view.approvalRequired, total: rows.length, next_offset: page.nextOffset, requests }; while (JSON.stringify(result).length > 3800 && requests.length > 1) requests.pop(); result.next_offset = page.offset + requests.length < rows.length ? page.offset + requests.length : null; return result; }),
    },
    {
      name: "get_policy_summary", title: "Get policy summary", description: "Inspect configuration state, the active policy contract, automatic checks, versions, request count, and current simulation state.",
      inputSchema: objectSchema({}), annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: safeExecute(() => {
        const data = getConfig().getData(); const needsConfiguration = workspaceNeedsConfiguration(data); const portfolio = allocateWorkspaceResources(data); const enabled = data.rules.filter((rule) => rule.enabled); const audit = auditPolicy(data.policy, data.rules, data.cases); const missingRateWindows = data.policy.resources.filter((resource) => resource.strategy === "rate_limit" && resource.windowSeconds === undefined).map((resource) => `rate window for ${resource.id}`);
        return {
          configuration: { status: needsConfiguration ? "required" : "configured", required_inputs: needsConfiguration ? ["outcomes", "boundary", "scoring", "governance", "resource or resources with positive capacity", ...missingRateWindows, ...(data.presetId === UNCONFIGURED_PRESET_ID ? ["fields", "ranking"] : [])] : [] },
          policy: needsConfiguration
            ? { status: "not_active", schema: { fields: data.policy.fields.map(({ key, label, type }) => ({ key, label, type })), resources: data.policy.resources.map(({ id, label, unit, strategy, divisible }) => ({ id, label, unit, strategy, divisible })), primary_resource_id: data.policy.primaryResourceId, ranking: data.policy.ranking } }
            : { status: "active_contract", name: data.policy.name, objective: data.policy.objective, outcomes: data.policy.outcomes, boundary: boundaryPolicy(data.policy), scoring: scoringPolicy(data.policy), governance: governancePolicy(data.policy), fields: data.policy.fields.map(({ key, type }) => ({ key, type })), resources: data.policy.resources, primary_resource_id: data.policy.primaryResourceId, ranking: data.policy.ranking },
          policy_audit: audit.slice(0, 5),
          policy_audit_count: audit.length,
          rule_summary: { total: data.rules.length, enabled: enabled.length, threshold: enabled.filter((rule) => rule.kind === "threshold").length, score: enabled.filter((rule) => rule.kind === "score").length, outcome: enabled.filter((rule) => rule.kind === "outcome").length, cap: enabled.filter((rule) => rule.kind === "cap").length },
          versions: data.versions.slice(-5).map(({ id, label }) => ({ id, label })), version_count: data.versions.length, request_count: data.cases.length,
          simulation: needsConfiguration ? { status: "waiting_for_policy_configuration", resources: [] } : data.cases.length ? { status: "calculated_from_current_inputs", resources: portfolio.resources } : { status: "waiting_for_request_inputs", resources: [] },
          ledger_events: data.ledger.length,
          external_execution: { total: data.executions.length, pending_approval: data.executions.filter((item) => item.status === "pending_approval").length, approved_for_agent: data.executions.filter((item) => item.status === "approved").length, cancelled: data.executions.filter((item) => item.status === "cancelled").length, completed: data.executions.filter((item) => item.status === "succeeded" || item.status === "failed").length },
          execution_governance: needsConfiguration ? { policy_applicable: false, reason: "Policy configuration is required." } : { policy_applicable: policyExecutionIssues(data.policy, data.rules, data.cases).length === 0, approval_required: governancePolicy(data.policy).requireApproval, eligible_actions_are: governancePolicy(data.policy).requireApproval ? "held_for_human_approval" : "authorized_automatically_by_policy" },
          external_actions: [
            { action_id: "github.issue.add_labels", server: "github", tool: "github_add_issue_labels", purpose: "Apply existing labels to the source GitHub issue after policy authorization." },
            { action_id: "github.issue.add_comment", server: "github", tool: "github_add_comment_to_issue", purpose: "Post a comment to the source GitHub issue after policy authorization." },
            { action_id: "github.pull_request.merge", server: "github", tool: "github_merge_pull_request", purpose: "Merge the exact source pull-request head SHA after policy and resource authorization." },
          ],
        };
      }),
    },
    {
      name: "create_policy", title: "Create or replace policy", description: "Update an active policy or configure a fresh workspace with explicit settings and positive capacity. Rate-limit resources require window_seconds. Schema identity changes require reset_workspace only when live rules, requests, or ledger events exist.",
      inputSchema: objectSchema({
        name: { type: "string" }, objective: { type: "string" }, outcomes: objectSchema({ eligible: { type: "string" }, boundary: { type: "string" }, review: { type: "string" } }, ["eligible", "boundary", "review"]),
        boundary: objectSchema({ tolerance: { type: "number", minimum: 0, maximum: 1 }, maximum_failed_rules: { type: "integer", minimum: 0, maximum: 10 } }, ["tolerance", "maximum_failed_rules"]),
        scoring: objectSchema({ base: { type: "number" }, minimum: { type: "number" }, maximum: { type: "number" } }, ["base", "minimum", "maximum"]),
        governance: objectSchema({ owner: { type: "string" }, status: { type: "string", enum: ["draft", "active", "retired"] }, effective_from: { type: "string" }, effective_until: { type: "string" }, require_approval: { type: "boolean" }, require_rationale: { type: "boolean" } }, ["owner", "status", "require_approval", "require_rationale"]),
        resource: objectSchema({ id: { type: "string" }, label: { type: "string" }, unit: { type: "string" }, capacity: { type: "number", minimum: 0 }, reserve: { type: "number", minimum: 0 }, strategy: { type: "string", enum: strategies }, divisible: { type: "boolean" }, window_seconds: { type: "number", minimum: 1, description: "Required when strategy is rate_limit; the rolling quota window in seconds." } }, ["id", "label", "unit", "capacity", "reserve", "strategy", "divisible"]),
        fields: { type: "array", minItems: 1, maxItems: WORKSPACE_LIMITS.fields, items: objectSchema({ key: { type: "string" }, label: { type: "string" }, type: { type: "string", enum: ["number", "integer", "enum", "boolean"] }, unit: { type: "string" }, options: { type: "array", items: { type: "string" } }, min: { type: "number" }, max: { type: "number" } }, ["key", "label", "type"]) },
        resources: { type: "array", minItems: 1, maxItems: WORKSPACE_LIMITS.resources, items: objectSchema({ id: { type: "string" }, label: { type: "string" }, unit: { type: "string" }, capacity: { type: "number", minimum: 0 }, reserve: { type: "number", minimum: 0 }, strategy: { type: "string", enum: strategies }, divisible: { type: "boolean" }, window_seconds: { type: "number", minimum: 1, description: "Required when strategy is rate_limit; the rolling quota window in seconds." } }, ["id", "label", "unit", "capacity", "reserve", "strategy", "divisible"]) },
        primary_resource_id: { type: "string" }, ranking: { type: "array", minItems: 1, maxItems: 10, items: objectSchema({ source: { type: "string", enum: ["score", "field", "demand"] }, key: { type: "string" }, direction: { type: "string", enum: ["asc", "desc"] } }, ["source", "direction"]) }, reset_workspace: { type: "boolean" },
      }, ["name", "objective"]), annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: safeExecute((input) => {
        const data = getConfig().getData(); const current = data.policy; const configuring = workspaceNeedsConfiguration(data); const blankWorkspace = data.presetId === UNCONFIGURED_PRESET_ID;
        if (configuring) {
          const missing = ["outcomes", "boundary", "scoring", "governance"].filter((key) => input[key] === undefined);
          if (input.resource === undefined && input.resources === undefined) missing.push("resource or resources");
          if (blankWorkspace && input.fields === undefined) missing.push("fields");
          if (blankWorkspace && input.ranking === undefined) missing.push("ranking");
          if (missing.length) throw new Error(`This workspace is unconfigured. Supply explicit ${missing.join(", ")} before it can be used.`);
        }
        const labels = input.outcomes === undefined ? current.outcomes : record(input.outcomes); const resourceInput = input.resource === undefined ? null : record(input.resource);
        if (input.resource !== undefined && input.resources !== undefined) throw new Error("Use either resource or resources, not both.");
        const fields = input.fields === undefined ? current.fields : Array.isArray(input.fields) ? input.fields.map(parseFieldDefinition) : (() => { throw new Error("fields must be an array."); })();
        const resources = input.resources !== undefined ? Array.isArray(input.resources) ? input.resources.map(parseResourcePool) : (() => { throw new Error("resources must be an array."); })() : resourceInput ? [parseResourcePool(resourceInput)] : current.resources;
        const ranking = input.ranking === undefined ? current.ranking : Array.isArray(input.ranking) ? input.ranking.map(parseRankingCriterion) : (() => { throw new Error("ranking must be an array."); })();
        const currentBoundary = boundaryPolicy(current), currentScoring = scoringPolicy(current), currentGovernance = governancePolicy(current); const boundaryInput = input.boundary === undefined ? null : record(input.boundary); const scoringInput = input.scoring === undefined ? null : record(input.scoring); const governanceInput = input.governance === undefined ? null : record(input.governance);
        const boundary = boundaryInput ? { tolerance: requiredNumber(boundaryInput.tolerance, "boundary.tolerance", 0, 1), maximumFailedRules: requiredNumber(boundaryInput.maximum_failed_rules, "boundary.maximum_failed_rules", 0, 10) } : currentBoundary; if (!Number.isInteger(boundary.maximumFailedRules)) throw new Error("boundary.maximum_failed_rules must be an integer.");
        const scoring = scoringInput ? { base: requiredNumber(scoringInput.base, "scoring.base", -100_000_000), minimum: requiredNumber(scoringInput.minimum, "scoring.minimum", -100_000_000), maximum: requiredNumber(scoringInput.maximum, "scoring.maximum", -100_000_000) } : currentScoring;
        const governance = governanceInput ? { owner: requiredString(governanceInput.owner, "governance.owner", 100), status: enumValue(governanceInput.status, "governance.status", ["draft", "active", "retired"] as const), ...(governanceInput.effective_from === undefined ? {} : { effectiveFrom: requiredString(governanceInput.effective_from, "governance.effective_from", 40) }), ...(governanceInput.effective_until === undefined ? {} : { effectiveUntil: requiredString(governanceInput.effective_until, "governance.effective_until", 40) }), requireApproval: requiredBoolean(governanceInput.require_approval, "governance.require_approval"), requireRationale: requiredBoolean(governanceInput.require_rationale, "governance.require_rationale") } : currentGovernance;
        const primaryResourceId = input.primary_resource_id === undefined ? (resources.some((resource) => resource.id === current.primaryResourceId) ? current.primaryResourceId : resources[0]?.id) : requiredString(input.primary_resource_id, "primary_resource_id", 40);
        if (resources.some((resource) => resource.reserve > resource.capacity)) throw new Error("Resource reserve cannot exceed capacity.");
        if (configuring && resources.some((resource) => resource.capacity <= 0)) throw new Error("Every resource must have an explicit capacity greater than zero before this workspace can be used.");
        const missingRateWindow = resources.find((resource) => resource.strategy === "rate_limit" && resource.windowSeconds === undefined); if (missingRateWindow) throw new Error(`resource.window_seconds is required for rate-limit resource ${missingRateWindow.id}.`);
        const policy: Policy = { name: requiredString(input.name, "name", 100), objective: requiredString(input.objective, "objective", 300), outcomes: { eligible: requiredString(labels.eligible, "outcomes.eligible", 40), boundary: requiredString(labels.boundary, "outcomes.boundary", 40), review: requiredString(labels.review, "outcomes.review", 40) }, fields, resources, primaryResourceId, ranking, boundary, scoring, governance };
        const schemaChanged = JSON.stringify({ fields: current.fields, resourceIds: current.resources.map(({ id }) => id), primaryResourceId: current.primaryResourceId }) !== JSON.stringify({ fields, resourceIds: resources.map(({ id }) => id), primaryResourceId });
        const resetWorkspace = input.reset_workspace === undefined ? false : requiredBoolean(input.reset_workspace, "reset_workspace"); const hasLiveInputs = data.rules.length > 0 || data.cases.length > 0 || data.ledger.length > 0;
        if (schemaChanged && hasLiveInputs && !resetWorkspace) throw new Error("Changing field or resource identities requires reset_workspace: true because active rules, requests, and ledger events cannot be migrated safely. Historical versions and impact reports are preserved.");
        if (resetWorkspace && (data.ledger.length > 0 || data.executions.length > 0)) throw new Error("reset_workspace cannot erase ledger or external execution evidence. Export the audit file and start a separate workspace for a new schema.");
        if (!policyIsValid(policy)) throw new Error("The supplied field, resource, primary-resource, or ranking schema is invalid.");
        const mutation = getConfig().actions.createPolicy(policy, resetWorkspace); return { success: true, status: mutation.status, proposal_id: mutation.proposalId, reset_workspace: resetWorkspace, policy: mutation.value };
      }),
    },
    {
      name: "add_rule", title: "Add policy rule", description: "Add a typed threshold, score, outcome, or allocation-cap rule using one or more AND/OR conditions.",
      inputSchema: objectSchema({ label: { type: "string" }, conditions: { type: "array", minItems: 1, maxItems: 8, items: objectSchema({ field: { type: "string" }, operator: { type: "string", enum: operators }, value: {} }, ["field", "operator", "value"]) }, match: { type: "string", enum: ["all", "any"] }, kind: { type: "string", enum: kinds }, points: { type: "number", minimum: -100, maximum: 100 }, result: { type: "string", enum: outcomes }, resource_id: { type: "string" }, amount: { type: "number", minimum: 0 }, priority: { type: "number", minimum: 0, maximum: 1000 } }, ["label", "conditions", "kind"]), annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: safeExecute((input) => { const config = getConfig(); assertPolicyConfigured(config.getData()); const mutation = config.actions.addRule(parseRuleInput(input, config.getData().policy)); return { success: true, status: mutation.status, proposal_id: mutation.proposalId, rule: mutation.value }; }),
    },
    {
      name: "update_rule", title: "Update policy rule", description: "Update one generic rule by stable ID; omitted properties keep their existing values.",
      inputSchema: objectSchema({ rule_id: { type: "string" }, label: { type: "string" }, conditions: { type: "array", minItems: 1, maxItems: 8, items: objectSchema({ field: { type: "string" }, operator: { type: "string", enum: operators }, value: {} }, ["field", "operator", "value"]) }, match: { type: "string", enum: ["all", "any"] }, kind: { type: "string", enum: kinds }, points: { type: "number", minimum: -100, maximum: 100 }, result: { type: "string", enum: outcomes }, resource_id: { type: "string" }, amount: { type: "number", minimum: 0 }, priority: { type: "number", minimum: 0, maximum: 1000 }, enabled: { type: "boolean" } }, ["rule_id"]), annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: safeExecute((input) => { const config = getConfig(); assertPolicyConfigured(config.getData()); const id = requiredString(input.rule_id, "rule_id", 20); const existing = config.getData().rules.find((rule) => rule.id === id); if (!existing) throw new Error("Rule not found."); const parsed = parseRuleInput(input, config.getData().policy, existing); const mutation = config.actions.updateRule(id, { ...parsed, enabled: input.enabled === undefined ? existing.enabled : requiredBoolean(input.enabled, "enabled") }); if (!mutation) throw new Error("Rule not found."); return { success: true, status: mutation.status, proposal_id: mutation.proposalId, rule: mutation.value }; }),
    },
    {
      name: "remove_rule", title: "Request rule removal", description: "Stage a rule for removal; it remains active until a human confirms in the page.", inputSchema: objectSchema({ rule_id: { type: "string" } }, ["rule_id"]), annotations: { readOnlyHint: false, destructiveHint: true, untrustedContentHint: false },
      execute: safeExecute((input) => { const config = getConfig(); assertPolicyConfigured(config.getData()); const rule = config.actions.requestRemoveRule(requiredString(input.rule_id, "rule_id", 20)); if (!rule) throw new Error("Rule not found."); return { success: true, status: "pending_human_confirmation", rule: { id: rule.id, label: rule.label } }; }),
    },
    {
      name: "upsert_cases", title: "Upsert requests", description: "Add or update typed requests with configured field values, resource demands, minimums, an optional group, and optional GitHub source provenance.",
      inputSchema: objectSchema({ cases: { type: "array", minItems: 1, maxItems: 25, items: objectSchema({ case_id: { type: "string" }, name: { type: "string" }, values: objectSchema({}, [], true), demands: objectSchema({}, [], true), minimums: objectSchema({}, [], true), group: { type: "string" }, source: objectSchema({ system: { type: "string", enum: ["github"] }, external_id: { type: "string" }, url: { type: "string" }, imported_at: { type: "string" } }, ["system", "external_id", "url"]) }, ["name", "values", "demands"]) } }, ["cases"]), annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: safeExecute((input) => { if (!Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > 25) throw new Error("cases must contain 1–25 items."); const config = getConfig(); const cases = input.cases.map((item) => parseCase(item, config.getData())); const ids = cases.flatMap((item) => item.id ? [item.id.trim().toLowerCase()] : []); const names = cases.map((item) => item.name.trim().toLowerCase()); if (new Set(ids).size !== ids.length || new Set(names).size !== names.length) throw new Error("Case IDs and names must be unique within a batch."); const current = config.getData().cases; for (const item of cases) { const byId = item.id ? current.find((entry) => entry.id.toLowerCase() === item.id?.toLowerCase()) : undefined; const byName = current.find((entry) => entry.name.trim().toLowerCase() === item.name.trim().toLowerCase()); if (item.id && byName && byName.id !== byId?.id) throw new Error(`case_id ${item.id} conflicts with existing request name ${item.name}.`); if (byId && current.some((entry) => entry.id !== byId.id && entry.name.trim().toLowerCase() === item.name.trim().toLowerCase())) throw new Error(`Case name ${item.name} conflicts with an existing request.`); } const additions = cases.filter((item) => item.id ? !current.some((entry) => entry.id.toLowerCase() === item.id?.toLowerCase()) : !current.some((entry) => entry.name.toLowerCase() === item.name.toLowerCase())).length; if (current.length + additions > WORKSPACE_LIMITS.cases) throw new Error(`A workspace can contain at most ${WORKSPACE_LIMITS.cases} requests.`); const mutation = config.actions.upsertCases(cases); const requests = mutation.value.map(({ id, name }) => ({ id, name })); return { success: true, status: mutation.status, proposal_id: mutation.proposalId, requests, ...(mutation.status === "applied" ? { saved: requests } : {}) }; }),
    },
    {
      name: "evaluate_cases", title: "Evaluate policy requests", description: "Deterministically evaluate requests, returning IDs, outcomes, traces, rank, and simulated allocations (not ledger commitments or usage). Omit case_ids to evaluate the active portfolio; follow next_offset until null for all pages.",
      inputSchema: objectSchema({ case_ids: { type: "array", maxItems: 10, items: { type: "string" } }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 5 } }), annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: safeExecute((input) => {
        const data = getConfig().getData();
        assertPolicyConfigured(data);
        if (input.case_ids !== undefined && !Array.isArray(input.case_ids)) throw new Error("case_ids must be an array.");
        const ids = Array.isArray(input.case_ids) ? input.case_ids.map((id) => requiredString(id, "case_id", 20)) : [];
        if (ids.length > 10) throw new Error("case_ids can contain at most 10 items.");
        const unknown = ids.filter((id) => !data.cases.some((item) => item.id === id));
        if (unknown.length) throw new Error(`Unknown case IDs: ${unknown.join(", ")}.`);
        const candidates = ids.length ? ids.map((id) => data.cases.find((item) => item.id === id)!) : data.cases;
        const page = pageInput(input, candidates.length, 3, 5);
        const selected = candidates.slice(page.offset, page.offset + page.limit);
        const portfolio = allocateWorkspaceResources(data);
        const allocations = new Map(portfolio.allocations.map((item) => [item.caseId, item]));
        return {
          total: candidates.length,
          offset: page.offset,
          next_offset: page.nextOffset,
          cases: evaluateAll(selected, data.rules, data.policy).map(({ caseId, score, outcome, failures, trace }) => {
            const allocation = allocations.get(caseId);
            return {
              case_id: caseId,
              score,
              outcome,
              failures,
              allocation: allocation && { rank: allocation.rank, funded: allocation.funded, resources: Object.fromEntries(Object.entries(allocation.resources).map(([id, item]) => [id, { allocated: item.allocated, status: item.status }])) },
              trace: trace.map(({ ruleId, kind, matched, effect }) => ({ rule_id: ruleId, kind, matched, effect })),
            };
          }),
        };
      }),
    },
    {
      name: "find_boundary_cases", title: "Find boundary requests", description: "Find requests nearest failed or passed numeric thresholds, including the request name, rule, field, operator, current value, and threshold value, ordered by normalized distance.", inputSchema: objectSchema({ max_results: { type: "integer", minimum: 1, maximum: 10 } }), annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: safeExecute((input) => { const data = getConfig().getData(); const limit = input.max_results === undefined ? 5 : requiredNumber(input.max_results, "max_results", 1, 10); if (!Number.isInteger(limit)) throw new Error("max_results must be an integer."); return findBoundaryCases(data.cases, data.rules, data.policy).slice(0, limit).map((item) => { const proximity = item.nearestFailedThreshold ?? item.nearestThreshold; const request = data.cases.find((entry) => entry.id === item.caseId); return { case_id: item.caseId, request_name: request?.name, outcome: item.outcome, rule_id: proximity?.ruleId, rule_label: proximity?.ruleLabel, field: proximity?.field, operator: proximity?.operator, actual_value: proximity?.actualValue, threshold_value: proximity?.thresholdValue, passed: proximity?.passed, distance: proximity?.distance, normalized_distance: proximity?.normalizedDistance }; }); }),
    },
    {
      name: "save_policy_version", title: "Save policy version", description: "Create an immutable policy snapshot; rationale is enforced when required by the current governance settings.", inputSchema: objectSchema({ label: { type: "string" }, rationale: { type: "string" } }, ["label"]), annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: safeExecute((input) => { const config = getConfig(); const required = governancePolicy(config.getData().policy).requireRationale; const supplied = optionalString(input.rationale, "rationale", 240); if (required && !supplied) throw new Error("rationale is required by the current policy."); return { success: true, version_id: config.actions.saveVersion(requiredString(input.label, "label", 60), supplied ?? "No rationale required by policy.") }; }),
    },
    {
      name: "compare_policy_versions", title: "Compare policy versions", description: "Compare a saved full-policy baseline with another saved version or current workspace, with bounded affected-request details.", inputSchema: objectSchema({ baseline_version_id: { type: "string" }, candidate_version_id: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 10 } }, ["baseline_version_id"]), annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: safeExecute((input) => { const data = getConfig().getData(); const baselineId = requiredString(input.baseline_version_id, "baseline_version_id", 30); const candidateId = input.candidate_version_id === undefined ? "current" : requiredString(input.candidate_version_id, "candidate_version_id", 30); const baseline = data.versions.find((version) => version.id === baselineId); const candidate = candidateId === "current" ? null : data.versions.find((version) => version.id === candidateId); if (!baseline) throw new Error("Baseline version not found."); if (candidateId !== "current" && !candidate) throw new Error("Candidate version not found."); const candidateSnapshot = candidate?.snapshot ?? { policy: data.policy, rules: data.rules, cases: data.cases }; const result = compareSimulationSnapshots(baseline.snapshot, candidateSnapshot); const limit = input.max_results === undefined ? 5 : requiredNumber(input.max_results, "max_results", 1, 10); if (!Number.isInteger(limit)) throw new Error("max_results must be an integer."); const resourceIds = [...new Set([...baseline.snapshot.policy.resources.map((resource) => resource.id), ...candidateSnapshot.policy.resources.map((resource) => resource.id)])]; return { policy_changed: result.policyChanged, changed_rules: result.changedRules.map(({ id }) => id), changed_requests: result.changedRequests, outcome_change_count: result.changedCases.length, rank_change_count: result.changedRanks.length, allocation_change_count: result.changedAllocations.length, changed_cases: result.changedCases.slice(0, limit).map(({ testCase, before, after }) => ({ case_id: testCase.id, before: before?.outcome ?? "missing", after: after?.outcome ?? "missing" })), changed_ranks: result.changedRanks.slice(0, limit).map(({ testCase, before, after }) => ({ case_id: testCase.id, before: before?.rank ?? null, after: after?.rank ?? null })), changed_allocations: result.changedAllocations.slice(0, limit).map(({ testCase, before, after }) => ({ case_id: testCase.id, funded_before: before?.funded ?? false, funded_after: after?.funded ?? false, resources: resourceIds.map((resourceId) => ({ resource_id: resourceId, before: before?.resources[resourceId]?.allocated ?? 0, after: after?.resources[resourceId]?.allocated ?? 0 })) })), results_truncated: result.changedCases.length > limit || result.changedRanks.length > limit || result.changedAllocations.length > limit }; }),
    },
    {
      name: "get_impact_reports", title: "Get policy impact reports", description: "List applied policy-impact reports or inspect one report's provenance, version references, outcome, rank, allocation, and per-resource ripple.",
      inputSchema: objectSchema({ report_id: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 10 } }), annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: safeExecute((input) => {
        const data = getConfig().getData();
        if (input.report_id === undefined) { const reports = [...data.impactReports].reverse(); const page = pageInput(input, reports.length, 5, 10); return { total: reports.length, offset: page.offset, next_offset: page.nextOffset, reports: reports.slice(page.offset, page.offset + page.limit).map((report) => ({ id: report.id, label: report.label, status: report.status, actor: report.actor, approved_by: publicReviewerIdentity(report.approvedBy), created_at: report.createdAt, baseline_version_id: report.baselineVersionId, candidate_version_id: report.candidateVersionId, outcome_changes: report.outcomeChanges, rank_changes: report.rankChanges, allocation_changes: report.allocationChanges, affected_requests: report.affectedCases.length })) }; }
        const id = requiredString(input.report_id, "report_id", 20), report = data.impactReports.find((item) => item.id === id); if (!report) throw new Error("Impact report not found.");
        const page = pageInput(input, report.affectedCases.length, 5, 10);
        return { id: report.id, label: report.label, rationale: report.rationale, status: report.status, actor: report.actor, approved_by: publicReviewerIdentity(report.approvedBy), created_at: report.createdAt, baseline_version_id: report.baselineVersionId, candidate_version_id: report.candidateVersionId, policy_changed: report.policyChanged, changed_rule_count: report.changedRules.length, changed_rules: report.changedRules.slice(0, 10), changed_rules_truncated: report.changedRules.length > 10, changed_request_count: report.changedRequests.length, changed_requests: report.changedRequests.slice(0, 10), changed_requests_truncated: report.changedRequests.length > 10, outcome_changes: report.outcomeChanges, rank_changes: report.rankChanges, allocation_changes: report.allocationChanges, resources: report.resources.map((item) => ({ resource_id: item.resourceId, before: item.before, after: item.after, delta: item.delta })), affected_case_count: report.affectedCases.length, affected_offset: page.offset, next_affected_offset: page.nextOffset, affected_cases: report.affectedCases.slice(page.offset, page.offset + page.limit).map((item) => ({ case_id: item.caseId, before: item.beforeOutcome, after: item.afterOutcome, rank_before: item.beforeRank, rank_after: item.afterRank, resources: item.resources.map((resource) => ({ resource_id: resource.resourceId, before: resource.before, after: resource.after, delta: resource.delta })) })) };
      }),
    },
    {
      name: "get_resource_ledger", title: "Get resource ledger", description: "Inspect available, reserved, committed, consumed, and policy-reserved capacity for every resource pool.", inputSchema: objectSchema({ resource_id: { type: "string" } }), annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: safeExecute((input) => { const data = getConfig().getData(); const selectedId = input.resource_id === undefined ? null : requiredString(input.resource_id, "resource_id", 40); const resources = selectedId ? data.policy.resources.filter((item) => item.id === selectedId) : data.policy.resources; if (!resources.length) throw new Error("Resource not found."); return resources.map((resource) => { const events = data.ledger.filter((event) => event.resourceId === resource.id); return { resource, state: resourceLedgerState(resource, data.ledger), recent_events: selectedId ? events.slice(-5) : [], event_count: events.length, events_truncated: selectedId ? events.length > 5 : events.length > 0 }; }); }),
    },
    {
      name: "reserve_resource", title: "Propose capacity reservation", description: "Stage a human-approved capacity reservation within one request's simulated allocation using an idempotency key; invalid or excessive reservations are rejected.", inputSchema: objectSchema({ request_id: { type: "string" }, resource_id: { type: "string" }, amount: { type: "number", exclusiveMinimum: 0 }, idempotency_key: { type: "string" }, note: { type: "string" } }, ["request_id", "resource_id", "amount", "idempotency_key"]), annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: safeExecute((input) => { const config = getConfig(); assertExecutionReady(config.getData()); const mutation = config.actions.appendLedger({ requestId: requiredString(input.request_id, "request_id", 20), resourceId: requiredString(input.resource_id, "resource_id", 40), amount: requiredNumber(input.amount, "amount", 0.000001), idempotencyKey: requiredString(input.idempotency_key, "idempotency_key", 120), type: "reserve", note: optionalString(input.note, "note", 240) ?? "Reserved through WebMCP." }); return { success: true, status: mutation.status, proposal_id: mutation.proposalId, event: mutation.value }; }),
    },
    {
      name: "reconcile_resource_usage", title: "Propose usage reconciliation", description: "Stage human-approved commit, actual consumption, and release events as one idempotent workflow.", inputSchema: objectSchema({ request_id: { type: "string" }, resource_id: { type: "string" }, actual_usage: { type: "number", minimum: 0 }, idempotency_key: { type: "string" } }, ["request_id", "resource_id", "actual_usage", "idempotency_key"]), annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: safeExecute((input) => { const config = getConfig(); const mutation = config.actions.reconcileUsage(requiredString(input.request_id, "request_id", 20), requiredString(input.resource_id, "resource_id", 40), requiredNumber(input.actual_usage, "actual_usage"), requiredString(input.idempotency_key, "idempotency_key", 100)); return { success: true, status: mutation.status, proposal_id: mutation.proposalId, reconciliation: mutation.value }; }),
    },
    {
      name: "propose_external_execution", title: "Propose external MCP execution", description: "Check the active policy, eligibility, allocation, remaining resource authorization, and exact GitHub target. Human approval is required when enabled; otherwise an eligible action is policy-authorized automatically.",
      inputSchema: objectSchema({ request_id: { type: "string" }, action_id: { type: "string", enum: PROPOSABLE_EXTERNAL_ACTIONS }, action_arguments: objectSchema({ repository_full_name: { type: "string" }, issue_number: { type: "integer", minimum: 1 }, labels: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } }, repo_full_name: { type: "string" }, pr_number: { type: "integer", minimum: 1 }, comment: { type: "string" }, expected_head_sha: { type: "string", pattern: "^[a-fA-F0-9]{40,64}$" }, merge_method: { type: "string", enum: ["merge", "squash", "rebase"] }, commit_title: { type: "string" }, commit_message: { type: "string" } }, [], false), resource_id: { type: "string" }, authorized_amount: { type: "number", exclusiveMinimum: 0 }, idempotency_key: { type: "string" } }, ["request_id", "action_id", "action_arguments", "resource_id", "authorized_amount", "idempotency_key"]), annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: safeExecute((input) => { const config = getConfig(); const mutation = config.actions.proposeExternalExecution({ requestId: requiredString(input.request_id, "request_id", 20), actionId: enumValue(input.action_id, "action_id", PROPOSABLE_EXTERNAL_ACTIONS), arguments: record(input.action_arguments), resourceId: requiredString(input.resource_id, "resource_id", 40), authorizedAmount: requiredNumber(input.authorized_amount, "authorized_amount", 0.000001), idempotencyKey: requiredString(input.idempotency_key, "idempotency_key", 120) }); const execution = publicExternalExecution(mutation.value); return { success: true, status: mutation.status, proposal_id: mutation.proposalId, policy_check: { passed_at_proposal: true, policy_version_id: execution.policyVersionId, request_outcome: "eligible", approval_required: execution.authorizationMode === "human_approval", authorization_mode: execution.authorizationMode, resource_amount_authorized: execution.authorizedAmount }, execution, next_step: mutation.status === "pending_human_confirmation" ? "Wait for human approval, then call get_external_execution before invoking GitHub MCP." : `The active policy authorized this exact action and reserved its resource amount. Call get_external_execution, then invoke the GitHub MCP tool ${execution.tool} with the stored arguments.` }; }),
    },
    {
      name: "get_external_execution", title: "List or get external executions", description: "List durable external executions after refresh, or inspect one approval state, exact GitHub MCP invocation, receipt, and ledger position.",
      inputSchema: objectSchema({ execution_id: { type: "string" }, status: { type: "string", enum: ["pending_approval", "approved", "rejected", "cancelled", "succeeded", "failed"] }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 10 } }), annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: safeExecute((input) => {
        const data = getConfig().getData();
        const mayInvoke = (execution: ExternalExecution) => {
          if (execution.status !== "approved" || executionRequiresBuiltIn(data, execution) || policyExecutionIssues(data.policy, data.rules, data.cases).length) return false;
          const version = data.versions.find((item) => item.id === execution.policyVersionId);
          if (!version) return false;
          const comparison = compareSimulationSnapshots(version.snapshot, createSnapshot(data.policy, data.rules, data.cases));
          return !comparison.policyChanged && !comparison.changedRules.length && !comparison.changedRequests.length;
        };
        if (input.execution_id === undefined) {
          const status = input.status === undefined ? null : enumValue(input.status, "status", ["pending_approval", "approved", "rejected", "cancelled", "succeeded", "failed"] as const);
          const executions = [...data.executions].reverse().filter((item) => !status || item.status === status); const page = pageInput(input, executions.length, 5, 10);
          return { total: executions.length, offset: page.offset, next_offset: page.nextOffset, executions: executions.slice(page.offset, page.offset + page.limit).map((execution) => ({ id: execution.id, status: execution.status, action_id: execution.actionId, server: execution.server, tool: execution.tool, request_id: execution.requestId, resource_id: execution.resourceId, authorized_amount: execution.authorizedAmount, authorization_mode: execution.authorizationMode, policy_version_id: execution.policyVersionId, proposed_at: execution.proposedAt, approved_at: execution.approvedAt, may_invoke_external_tool: mayInvoke(execution), result: execution.receipt ? { status: execution.receipt.status, external_reference: execution.receipt.externalReference, result_url: execution.receipt.resultUrl, actual_usage: execution.receipt.actualUsage } : null })) };
        }
        const id = requiredString(input.execution_id, "execution_id", 20); const execution = data.executions.find((item) => item.id === id); if (!execution) throw new Error("External execution not found.");
        const accounting = externalExecutionAccounting(data, execution);
        const pinnedVersion = data.versions.find((item) => item.id === execution.policyVersionId); const pinnedComparison = pinnedVersion ? compareSimulationSnapshots(pinnedVersion.snapshot, createSnapshot(data.policy, data.rules, data.cases)) : null; const activeInputsMatchPinnedVersion = Boolean(pinnedComparison && !pinnedComparison.policyChanged && !pinnedComparison.changedRules.length && !pinnedComparison.changedRequests.length);
        const nextStep = execution.status === "approved" && execution.attempt ? "Use the built-in executor to reconcile with GitHub; do not invoke another merge." : execution.status === "approved" && executionRequiresBuiltIn(data, execution) ? "Use the built-in executor to revalidate this saved portfolio action and any pinned configuration budget." : mayInvoke(execution) ? `Invoke the GitHub MCP tool ${execution.tool} with the exact stored arguments, then call record_external_execution.` : execution.status === "pending_approval" ? "Wait for human approval in RuleRipple." : execution.status === "succeeded" && execution.receipt?.actualUsage === undefined ? "The action receipt has no metered usage. Check request_ledger_state for current balances, including later request-level reconciliation." : execution.status === "succeeded" ? "The receipt retains provider-reported usage. Check request_ledger_state for current balances, including later corrections." : "No external invocation is authorized.";
        return { execution: publicExternalExecution(execution), policy_check: { passed_at_proposal: true, policy_version_id: execution.policyVersionId, current_policy_applicable: policyExecutionIssues(data.policy, data.rules, data.cases).length === 0, active_inputs_match_pinned_version: activeInputsMatchPinnedVersion, approval_required: execution.authorizationMode === "human_approval", authorization_mode: execution.authorizationMode }, may_invoke_external_tool: mayInvoke(execution), invocation: mayInvoke(execution) ? { server: execution.server, tool: execution.tool, arguments: execution.arguments, arguments_fingerprint: execution.argumentsFingerprint } : null, ledger_state: accounting.actionEvents, ledger_scope: "execution_events_only", request_ledger_state: accounting.requestTotals, next_step: nextStep };
      }),
    },
    {
      name: "record_external_execution", title: "Record external MCP result", description: "Attach an attributable success or failure receipt after a human- or policy-authorized GitHub MCP call. Optional provider-reported actual_usage is reconciled against that exact authorization.",
      inputSchema: objectSchema({ execution_id: { type: "string" }, status: { type: "string", enum: ["succeeded", "failed"] }, external_reference: { type: "string" }, result_url: { type: "string" }, summary: { type: "string" }, actual_usage: { type: "number", minimum: 0 } }, ["execution_id", "status", "external_reference", "summary"]), annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: safeExecute((input) => { const config = getConfig(); const data = config.getData(), existing = data.executions.find((item) => item.id === input.execution_id); if (existing && executionRequiresBuiltIn(data, existing)) throw new Error("This invocation is owned by the built-in executor. Reconcile its result through RuleRipple."); const execution = config.actions.recordExternalExecution(requiredString(input.execution_id, "execution_id", 20), { status: enumValue(input.status, "status", ["succeeded", "failed"] as const), externalReference: requiredString(input.external_reference, "external_reference", 200), ...(input.result_url === undefined ? {} : { resultUrl: requiredString(input.result_url, "result_url", 300) }), summary: requiredString(input.summary, "summary", 240), ...(input.actual_usage === undefined ? {} : { actualUsage: requiredNumber(input.actual_usage, "actual_usage") }) }); return { success: true, execution: publicExternalExecution(execution), next_step: execution.status === "succeeded" && execution.receipt?.actualUsage !== undefined ? "Provider-reported usage is consumed against this execution and unused authorization is released." : execution.status === "succeeded" ? "The authorization was committed when this action completed. Read get_external_execution for current request balances." : "The failed action released its reservation." }; }),
    },
  ];
}

export const supportedAllocationStrategies = allocationStrategyLabels;
export const getPrimaryResource = primaryResource;
