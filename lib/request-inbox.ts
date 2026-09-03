import { appendLedgerEvent, createSnapshot, governancePolicy, nextId, policyExecutionIssues, primaryResource, safeWorkspace, validCase, WORKSPACE_LIMITS, type FieldValue, type InboxRequest, type TestCase, type WorkspaceData } from "./domain.ts";
import type { AppState } from "./cloud-state.ts";
import { canonicalJson, stableCaseId } from "./operator-intake.ts";
import { parsePullReference, validateBatchSelections } from "./operator-batch.ts";
import { portfolioBudgetPlan } from "./budget-plan.ts";
import { nextActivityId } from "./history.ts";
import { executionPolicyIsCurrent } from "./execution-state.ts";

export class InboxError extends Error {}
export interface AgentRequestInput {
  submission_id: string;
  agent: { id: string; name: string };
  source: { system: string; external_id: string; url?: string };
  name: string;
  reason: string;
  resource_id: string;
  requested: number;
  minimum: number;
  values: Record<string, FieldValue>;
  execution?: InboxRequest["execution"];
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InboxError("Expected a request object.");
  return value as Record<string, unknown>;
};
function keys(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).some((key) => !allowed.includes(key))) throw new InboxError("Request includes unknown fields. Decisions, ranks and authorization cannot be submitted by an agent."); }
function text(value: unknown, label: string, max: number) { if (typeof value !== "string" || !value.trim() || value.length > max) throw new InboxError(`${label} is required (maximum ${max} characters).`); return value.trim(); }
export async function inboxFingerprint(value: unknown): Promise<string> { const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))); return `sha256-${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`; }

export function parseAgentRequest(value: unknown, data: WorkspaceData): AgentRequestInput {
  const input = object(value); keys(input, ["submission_id", "agent", "source", "name", "reason", "resource_id", "requested", "minimum", "values", "execution"]);
  const agent = object(input.agent), source = object(input.source); keys(agent, ["id", "name"]); keys(source, ["system", "external_id", "url"]);
  const system = text(source.system, "Source system", 40).toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(system)) throw new InboxError("Source system must be a simple identifier.");
  const url = source.url === undefined ? undefined : text(source.url, "Source URL", 500);
  if (url) { let parsed: URL; try { parsed = new URL(url); } catch { throw new InboxError("Source URL must be HTTPS."); } if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new InboxError("Source URL must be HTTPS without credentials."); }
  const resourceId = text(input.resource_id, "Resource", 40);
  if (!data.policy.resources.some((item) => item.id === resourceId)) throw new InboxError("Choose a resource configured in this policy.");
  const requested = input.requested, minimum = input.minimum;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0 || typeof minimum !== "number" || !Number.isFinite(minimum) || minimum < 0 || minimum > requested) throw new InboxError("Requested amount must be positive; minimum must be between zero and that amount.");
  const result: AgentRequestInput = { submission_id: text(input.submission_id, "Submission ID", 160), agent: { id: text(agent.id, "Agent ID", 80), name: text(agent.name, "Agent name", 80) }, source: { system, external_id: text(source.external_id, "Source request ID", 160), ...(url ? { url } : {}) }, name: text(input.name, "Request title", 100), reason: text(input.reason, "Reason", 500), resource_id: resourceId, requested, minimum, values: object(input.values) as Record<string, FieldValue> };
  const candidate: TestCase = { id: "validation", name: result.name, group: result.agent.name, values: result.values, demands: { [resourceId]: requested }, minimums: { [resourceId]: minimum }, actualUsage: {} };
  if (!validCase(candidate, data.policy)) throw new InboxError("Supply every typed policy field with its configured range or options, and whole resource units where required.");
  if (input.execution !== undefined) {
    const execution = object(input.execution); keys(execution, ["adapter", "reference", "budget"]);
    if (execution.adapter !== "github" || system !== "github" || !url || resourceId !== primaryResource(data.policy).id) throw new InboxError("A GitHub action needs canonical GitHub provenance and the policy's primary resource.");
    const selection = validateBatchSelections([{ reference: execution.reference, ...(execution.budget === undefined ? {} : { budget: execution.budget }) }])[0];
    const target = parsePullReference(selection.reference);
    if (url.toLowerCase().replace(/\/$/, "") !== `https://github.com/${target.repository}/pull/${target.number}` || result.source.external_id.toLowerCase() !== target.reference) throw new InboxError("The action target must match its source request.");
    result.source.external_id = target.reference;
    result.execution = { adapter: "github", ...selection };
  }
  return result;
}

function activity(app: AppState, action: string, detail: string): AppState {
  return { ...app, data: { ...app.data, activity: [{ id: nextActivityId(app.data.activity, app.undo), actor: "engine" as const, action, detail: detail.slice(0, 300), createdAt: new Date().toISOString(), undoable: false }, ...app.data.activity].slice(0, WORKSPACE_LIMITS.activity) } };
}
function checked(app: AppState): AppState { const data = safeWorkspace(app.data); if (!data) throw new InboxError("The request conflicts with the workspace schema, history or a request name. Nothing was changed."); return { ...app, data }; }
export async function requestInboxView(data: WorkspaceData) {
  const blockers = policyExecutionIssues(data.policy, data.rules, data.cases).map((item) => item.message);
  const plans = new Map(data.policy.resources.map((resource) => [resource.id, portfolioBudgetPlan(data, resource.id)]));
  const reviewFingerprint = await inboxFingerprint({ policy: data.policy, rules: data.rules, cases: data.cases, ledger: data.ledger, executions: data.executions, inbox: data.inbox ?? [], blockers, budgets: [...plans.values()].map((plan) => ({ id: plan.resource.id, available: plan.available, rows: plan.rows.map((row) => ({ id: row.request.id, amount: row.amount })) })) });
  const rows = (data.inbox ?? []).map((entry) => {
    const plan = plans.get(entry.resourceId)!;
    const row = plan.rows.find((item) => item.request.id === entry.requestId)!;
    const execution = [...data.executions].reverse().find((item) => item.requestId === entry.requestId);
    const stale = Boolean(execution && ["pending_approval", "approved"].includes(execution.status) && !execution.attempt && !executionPolicyIsCurrent(data, execution));
    const status = entry.decision?.status ?? (stale ? "stale" : execution ? execution.status : blockers.length ? "blocked" : row.evaluation.outcome !== "eligible" ? "needs_review" : row.amount <= 0 ? "waiting_for_budget" : entry.execution ? "needs_verification" : "pending_approval");
    return { accounting: { reserved: row.held.reserved, committed: row.held.committed, consumed: row.held.consumed, remainingAuthorization: row.held.reserved + row.held.committed }, settled: Boolean(entry.decision?.status === "approved" && row.held.reserved + row.held.committed <= 0.000001), requestId: entry.requestId, agent: entry.agent, source: entry.source, name: row.request.name, reason: entry.reason, receivedAt: entry.receivedAt, resourceId: entry.resourceId, unit: plan.resource.unit, requested: row.request.demands[entry.resourceId] ?? 0, minimum: row.request.minimums[entry.resourceId] ?? 0, outcome: row.evaluation.outcome, rank: row.allocation.rank, simulated: row.simulated, proposed: blockers.length ? 0 : row.amount, prepared: !stale && execution?.status === "pending_approval" ? execution.authorizedAmount : 0, authorized: entry.decision?.amount ?? (!stale && execution && ["approved", "succeeded"].includes(execution.status) ? execution.authorizedAmount : 0), status, executionId: execution?.id ?? null, adapter: entry.execution?.adapter ?? null, trace: row.evaluation.trace, explanation: stale ? "The policy or requests changed. Resolve this stale action before preparing a new authorization." : execution && ["rejected", "cancelled", "failed"].includes(execution.status) ? "The previous action is retained in execution history. Verify the source again before preparing another action." : entry.decision?.status === "rejected" ? "Request declined. No capacity is held for this request." : entry.decision ? `Authorization recorded: ${row.held.reserved} ${plan.resource.unit} reserved, ${row.held.committed} committed, ${row.held.consumed} consumed. Submit a new request for additional work.` : blockers[0] ?? (row.evaluation.outcome !== "eligible" ? "Eligibility conditions require review." : execution ? execution.status === "pending_approval" ? "Action prepared for review. No budget is authorized until approval." : "See the external action history for its authorization and execution evidence." : row.amount > 0 ? `${row.amount} ${plan.resource.unit} available under the policy after existing commitments and higher-ranked requests.` : "No additional budget available after commitments and higher-ranked requests, at the requested minimum.") };
  }).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.requestId.localeCompare(b.requestId));
  return { reviewFingerprint, approvalRequired: governancePolicy(data.policy).requireApproval, blockers, portfolioCount: data.cases.length - (data.inbox ?? []).filter((entry) => entry.decision?.status === "rejected").length, rows };
}
export type InboxView = Awaited<ReturnType<typeof requestInboxView>>;

export async function receiveAgentRequests(app: AppState, raw: unknown): Promise<{ app: AppState; received: string[]; duplicates: string[] }> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 25) throw new InboxError("Submit between one and 25 requests per delivery.");
  if (app.data.policy.resources.every((resource) => resource.capacity <= 0)) throw new InboxError("Configure a policy and resource capacity before receiving requests.");
  const inputs = raw.map((item) => parseAgentRequest(item, app.data));
  let next = structuredClone(app); next.data.inbox ??= [];
  const received: string[] = [], duplicates: string[] = [];
  for (const input of inputs) {
    const fingerprint = await inboxFingerprint(input);
    const existing = next.data.inbox.find((entry) => entry.submissionId === input.submission_id);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new InboxError("This submission ID was already used for different inputs. Send a new request for additional work."); duplicates.push(existing.requestId); continue; }
    if (next.data.inbox.some((entry) => entry.source.system === input.source.system && entry.source.externalId === input.source.external_id)) throw new InboxError("This source request already exists. Reuse its submission ID for an exact retry, or use a new source request ID for additional work.");
    const target = input.execution ? parsePullReference(input.execution.reference) : null;
    const requestId = target ? stableCaseId(target.repository, target.number) : `RQ-${fingerprint.slice(7, 23)}`;
    if (next.data.cases.some((item) => item.id === requestId)) throw new InboxError("This request already exists in the workspace. Its existing inputs and history were preserved.");
    const now = new Date().toISOString();
    const request: TestCase = { id: requestId, name: input.name, group: input.agent.name, values: input.values, demands: { [input.resource_id]: input.requested }, minimums: { [input.resource_id]: input.minimum }, actualUsage: {}, ...(target ? { source: { system: "github" as const, externalId: target.reference, url: input.source.url!, importedAt: now } } : {}) };
    next.data.cases.push(request);
    next.data.inbox.push({ requestId, submissionId: input.submission_id, agent: input.agent, source: { system: input.source.system, externalId: input.source.external_id, ...(input.source.url ? { url: input.source.url } : {}) }, resourceId: input.resource_id, reason: input.reason, receivedAt: now, fingerprint, ...(input.execution ? { execution: input.execution } : {}) });
    received.push(requestId);
  }
  next.data.cases.sort((a, b) => a.id.localeCompare(b.id));
  next = checked(next);
  if (received.length) next = activity(next, "Agent requests received", `${received.length} incoming request${received.length === 1 ? "" : "s"} added to the shared portfolio. No external action invoked.`);
  if (received.length && !governancePolicy(next.data.policy).requireApproval) {
    const view = await requestInboxView(next.data);
    for (const row of view.rows.filter((row) => row.status === "pending_approval" && row.proposed > 0)) {
      next = await decideInboxRequest(next, { request_id: row.requestId, decision: "approve", review_fingerprint: (await requestInboxView(next.data)).reviewFingerprint, rationale: "Authorized automatically under the active policy." }, "Active policy", true);
    }
  }
  return { app: checked(next), received, duplicates };
}

export async function decideInboxRequest(app: AppState, raw: unknown, reviewer: string, automatic = false): Promise<AppState> {
  const input = object(raw); keys(input, ["request_id", "decision", "review_fingerprint", "rationale"]);
  const id = text(input.request_id, "Request ID", 20), rationale = text(input.rationale, "Decision rationale", 240);
  if (!["approve", "reject"].includes(String(input.decision))) throw new InboxError("Choose approve or reject.");
  const entry = app.data.inbox?.find((item) => item.requestId === id);
  if (!entry) throw new InboxError("Incoming request not found.");
  if (entry.decision) throw new InboxError("This request already has a recorded decision.");
  if (entry.execution) throw new InboxError("Verify this request with its source adapter and approve the exact external action.");
  const view = await requestInboxView(app.data), row = view.rows.find((item) => item.requestId === id)!;
  if (input.review_fingerprint !== view.reviewFingerprint) throw new InboxError("The portfolio changed while you were reviewing. Refresh the inbox and review the new allocation.");
  if (automatic && governancePolicy(app.data.policy).requireApproval) throw new InboxError("Human approval is enabled.");
  if (input.decision === "approve" && (view.blockers.length || row.outcome !== "eligible" || row.proposed <= 0)) throw new InboxError("This request is not eligible for additional budget under the current policy and commitments.");
  let next = structuredClone(app);
  const snapshot = createSnapshot(next.data.policy, next.data.rules, next.data.cases);
  let version = next.data.versions.at(-1);
  if (!version || canonicalJson(version.snapshot) !== canonicalJson(snapshot)) {
    version = { id: nextId("V", next.data.versions), label: "Incoming budget decision", rationale, createdAt: new Date().toISOString(), snapshot };
    next.data.versions.push(version);
  }
  const amount = input.decision === "approve" ? row.proposed : 0;
  if (amount > 0) next.data = appendLedgerEvent(next.data, { idempotencyKey: `inbox:${id}:reserve`, requestId: id, resourceId: entry.resourceId, type: "reserve", amount, actor: automatic ? "engine" : "human", note: `Budget authorized for ${entry.agent.name}; usage has not been reported.` }).workspace;
  next.data.inbox!.find((item) => item.requestId === id)!.decision = { status: input.decision === "approve" ? "approved" : "rejected", amount, by: reviewer, at: new Date().toISOString(), policyVersionId: version.id, rationale, reviewFingerprint: view.reviewFingerprint };
  next = activity(next, amount ? "Agent budget authorized" : "Agent budget declined", `${entry.agent.name}: ${amount} ${row.unit}. ${rationale}`);
  return checked(next);
}

export function assertInboxUnchanged(before: WorkspaceData | undefined, after: WorkspaceData) {
  if (canonicalJson(before?.inbox ?? []) !== canonicalJson(after.inbox ?? [])) throw new InboxError("Incoming requests and their decisions are server-owned. Use the request inbox.");
  for (const entry of before?.inbox ?? []) {
    const prior = before!.cases.find((item) => item.id === entry.requestId), next = after.cases.find((item) => item.id === entry.requestId);
    if (!prior || !next || canonicalJson({ ...prior, actualUsage: {} }) !== canonicalJson({ ...next, actualUsage: {} })) throw new InboxError("Received inputs cannot be rewritten. Submit a new request for changed work.");
    if (!entry.execution && canonicalJson(before!.ledger.filter((event) => event.requestId === entry.requestId && event.type === "reserve")) !== canonicalJson(after.ledger.filter((event) => event.requestId === entry.requestId && event.type === "reserve"))) throw new InboxError("Incoming budget reservations must be authorized through the request inbox.");
    if (entry.decision && canonicalJson(before!.versions.find((item) => item.id === entry.decision!.policyVersionId)) !== canonicalJson(after.versions.find((item) => item.id === entry.decision!.policyVersionId))) throw new InboxError("The policy snapshot for a budget decision is immutable.");
    if (entry.decision && canonicalJson(before!.ledger.filter((event) => event.idempotencyKey === `inbox:${entry.requestId}:reserve`)) !== canonicalJson(after.ledger.filter((event) => event.idempotencyKey === `inbox:${entry.requestId}:reserve`))) throw new InboxError("The original budget reservation is immutable.");
  }
}
