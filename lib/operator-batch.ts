import { compareSimulationSnapshots, createPolicyImpactReport, createSnapshot, nextId, policyExecutionIssues, primaryResource, proposeExternalExecution, safeWorkspace, WORKSPACE_LIMITS, type RequestBatch, type TestCase } from "./domain.ts";
import type { AppState } from "./cloud-state.ts";
import type { GitHubPullRequest } from "./github-server.ts";
import { canonicalJson, requestInputFingerprint, requestInputFromPullRequest } from "./operator-intake.ts";
import { nextActivityId } from "./history.ts";
import { portfolioBudgetPlan } from "./budget-plan.ts";

export interface BudgetBinding { path: string; pointer: string; mode: "total" | "increase"; }
export interface BatchSelection { reference: string; budget?: BudgetBinding; }
export interface BatchInspection { pull: GitHubPullRequest; budget?: BudgetBinding & { baseSha: string; amount: number }; }
export class BatchError extends Error {}

export function parsePullReference(reference: string) {
  const match = /^(?:https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*))$/.exec(reference.trim());
  if (!match) throw new BatchError("Use a GitHub pull-request URL or owner/repository#123.");
  const repository = (match[1] ?? match[3]).toLowerCase(), number = Number(match[2] ?? match[4]);
  if (!Number.isSafeInteger(number)) throw new BatchError("Invalid pull-request number.");
  return { repository, number, reference: `${repository}#${number}` };
}

export function validateBatchSelections(input: unknown): BatchSelection[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 5) throw new BatchError("Select between one and five pull requests.");
  const selections = input.map((item): BatchSelection => {
    if (!item || typeof item.reference !== "string") throw new BatchError("Each request needs a GitHub reference.");
    const reference = parsePullReference(item.reference).reference;
    if (item.budget === undefined) return { reference };
    const { path, pointer, mode } = item.budget ?? {};
    if (typeof path !== "string" || path.length > 240 || !/^[A-Za-z0-9_.\/-]+\.json$/.test(path) || path.split("/").some((part: string) => !part || part === "." || part === "..") || typeof pointer !== "string" || pointer.length > 200 || !/^\/(?:[^~]|~[01])+$/.test(pointer) || !["total", "increase"].includes(mode)) throw new BatchError("Budget verification requires a repository-relative JSON path, a JSON pointer, and total or increase mode.");
    return { reference, budget: { path, pointer, mode } };
  });
  const unique = new Map<string, BatchSelection>();
  for (const item of selections) {
    if (unique.has(item.reference) && canonicalJson(unique.get(item.reference)) !== canonicalJson(item)) throw new BatchError("Duplicate PR references have conflicting budget mappings.");
    unique.set(item.reference, item);
  }
  return [...unique.values()].sort((a, b) => a.reference.localeCompare(b.reference));
}

function numericPointer(document: unknown, pointer: string): number {
  let current = document;
  for (const key of pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) throw new BatchError("The configured budget field is missing.");
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current !== "number" || !Number.isFinite(current) || current < 0) throw new BatchError("The configured budget field must be a non-negative JSON number.");
  return current;
}

export function verifiedBudgetAmount(binding: BudgetBinding, before: unknown | null, after: unknown): number {
  const next = numericPointer(after, binding.pointer);
  const previous = before === null ? 0 : numericPointer(before, binding.pointer);
  if (next === previous) throw new BatchError("The selected budget field does not change in this PR.");
  const amount = binding.mode === "increase" ? next - previous : next;
  if (amount <= 0) throw new BatchError("The selected budget change does not authorize a positive amount.");
  return amount;
}

export async function sha256(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return `sha256-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// All remote inspection finishes before any workspace mutation is constructed.
export async function reviewRequestBatch(app: AppState, input: unknown, inspect: (selection: BatchSelection) => Promise<BatchInspection>) {
  const selections = validateBatchSelections(input);
  const inspections = await Promise.all(selections.map(inspect));
  const incoming: TestCase[] = [], fingerprints: string[] = [];
  for (const [index, inspection] of inspections.entries()) {
    const { pull, budget } = inspection;
    const expected = parsePullReference(selections[index].reference);
    if (pull.repositoryFullName.toLowerCase() !== expected.repository || pull.number !== expected.number || pull.htmlUrl.toLowerCase().replace(/\/$/, "") !== `https://github.com/${expected.repository}/pull/${expected.number}`) throw new BatchError("GitHub returned a different source target.");
    if (pull.state !== "open" || pull.draft || pull.merged || pull.mergeable !== true) throw new BatchError(`${expected.reference}: GitHub must report open, non-draft and mergeable.`);
    const parsed = requestInputFromPullRequest(pull, app.data);
    if (!parsed.requestInput || parsed.errors.length) throw new BatchError(`${expected.reference}: ${parsed.errors.join(" ")}`);
    const raw = parsed.requestInput, resource = primaryResource(app.data.policy);
    const demands = raw.demands as Record<string, number>, minimums = raw.minimums as Record<string, number>;
    const received = app.data.inbox?.find((item) => item.requestId === raw.case_id);
    const receivedCase = received ? app.data.cases.find((item) => item.id === received.requestId)! : undefined;
    if (received && (!received.execution || received.execution.reference !== selections[index].reference || canonicalJson(received.execution.budget) !== canonicalJson(selections[index].budget))) throw new BatchError("Use the execution mapping attached to the received request; do not replace its evidence binding.");
    if (receivedCase && (receivedCase.name !== raw.name || canonicalJson(receivedCase.values) !== canonicalJson(raw.values) || resource.id !== received!.resourceId || resource.id && (receivedCase.demands[resource.id] !== demands[resource.id] || receivedCase.minimums[resource.id] !== minimums[resource.id]))) throw new BatchError("The source declaration does not match the received agent request. Changed work needs a new request; no action was prepared.");
    if (received?.decision?.status === "rejected") throw new BatchError("This received request was declined. Submit a new request for changed work.");
    if (selections[index].budget && (!budget || canonicalJson(selections[index].budget) !== canonicalJson({ path: budget.path, pointer: budget.pointer, mode: budget.mode }))) throw new BatchError("Budget mapping was not verified.");
    if (budget && (budget.amount !== demands[resource.id] || minimums[resource.id] !== budget.amount)) throw new BatchError(`${expected.reference}: requested amount and minimum must both equal the verified configuration budget. A merge cannot apply a partial configuration change.`);
    const source = raw.source as Record<string, string>;
    incoming.push(receivedCase ? structuredClone(receivedCase) : { id: raw.case_id as string, name: raw.name as string, values: raw.values as TestCase["values"], demands, minimums, actualUsage: app.data.cases.find((item) => item.id === raw.case_id)?.actualUsage ?? {}, group: raw.group as string, source: { system: "github", externalId: source.external_id, url: source.url, importedAt: source.imported_at } });
    fingerprints.push(await requestInputFingerprint(raw));
  }
  if (new Set(incoming.map((item) => item.id)).size !== incoming.length) throw new BatchError("Source identities collide; no requests were imported.");
  for (const request of incoming) {
    const existing = app.data.cases.find((item) => item.id === request.id);
    if (existing && app.data.ledger.some((event) => event.requestId === request.id) && canonicalJson(existing) !== canonicalJson(request)) throw new BatchError(`${request.name} has ledger history. Its recorded inputs cannot be replaced; create a new request for changed work.`);
    if (existing && existing.source?.externalId.toLowerCase() !== request.source!.externalId.toLowerCase()) throw new BatchError("A source identity conflicts with an existing request.");
    if (app.data.cases.filter((item) => item.source?.externalId.toLowerCase() === request.source!.externalId.toLowerCase()).length > 1) throw new BatchError("Multiple existing requests identify this GitHub source; resolve them before reviewing.");
  }
  let data = structuredClone(app.data);
  for (const request of incoming) {
    const index = data.cases.findIndex((item) => item.id === request.id);
    if (index >= 0) data.cases[index] = request; else data.cases.push(request);
  }
  // Stable ordering prevents input order from becoming a hidden tie breaker.
  data.cases.sort((a, b) => a.id.localeCompare(b.id));
  const snapshot = createSnapshot(data.policy, data.rules, data.cases);
  for (const [index, request] of incoming.entries()) {
    for (const action of data.executions.filter((item) => item.requestId === request.id && ["pending_approval", "approved"].includes(item.status))) {
      const pinned = data.versions.find((item) => item.id === action.policyVersionId)?.snapshot;
      const changes = pinned ? compareSimulationSnapshots(pinned, snapshot) : null;
      const { pull, budget } = inspections[index];
      if (!changes || changes.policyChanged || changes.changedRules.length || changes.changedRequests.length || action.arguments.expected_head_sha !== pull.headSha || action.sourceFingerprint !== fingerprints[index] || canonicalJson(action.budgetBinding) !== canonicalJson(budget)) {
        throw new BatchError(`Resolve existing action ${action.id} in External actions before reviewing changed inputs. Reject a pending action or revoke an uninvoked approval; reconcile any attempted action first.`);
      }
    }
  }
  const before = createSnapshot(app.data.policy, app.data.rules, app.data.cases);
  const comparison = compareSimulationSnapshots(before, snapshot);
  const last = data.versions.at(-1);
  if (comparison.changedRequests.length || !last || canonicalJson(last.snapshot) !== canonicalJson(snapshot)) {
    if (data.versions.length >= WORKSPACE_LIMITS.versions || data.impactReports.length >= WORKSPACE_LIMITS.impactReports) throw new BatchError("Version storage is full. Preserve the audit file before starting a new workspace.");
    const id = nextId("V", data.versions), createdAt = new Date().toISOString();
    data.versions.push({ id, createdAt, label: "Connected requests reviewed together", rationale: "All selected sources validated before portfolio evaluation.", snapshot });
    data.impactReports.push(createPolicyImpactReport({ id: nextId("IR", data.impactReports), label: "Connected requests reviewed together", rationale: "All selected sources validated before portfolio evaluation.", actor: "agent", approvedBy: null, baseline: before, candidate: snapshot, baselineVersionId: last?.id ?? null, candidateVersionId: id, createdAt }));
  }
  if (!safeWorkspace(data)) throw new BatchError("The selected requests conflict with the workspace schema or existing request names.");
  const blockers = policyExecutionIssues(data.policy, data.rules, data.cases);
  if (blockers.length) throw new BatchError(blockers.map((issue) => issue.message).join(" "));
  const fingerprint = await sha256(snapshot), resource = primaryResource(data.policy);
  const plan = portfolioBudgetPlan(data, resource.id);
  const available = plan.available;
  const selected = new Map(incoming.map((item, index) => [item.id, index]));
  const batch: RequestBatch = { id: nextId("B", data.batches ?? []), createdAt: new Date().toISOString(), policyVersionId: data.versions.at(-1)!.id, portfolioFingerprint: fingerprint, resourceId: resource.id, unit: resource.unit, availableAtReview: available, rows: [] };
  for (const planned of plan.rows) {
    const { request, allocation, evaluation } = planned;
    const simulated = allocation.resources[resource.id];
    let amount = planned.amount;
    const index = selected.get(request.id);
    if (index === undefined) continue;
    const { pull, budget } = inspections[index];
    if (budget && amount < budget.amount) amount = 0;
    const prior = data.executions.find((item) => item.requestId === request.id && item.actionId === "github.pull_request.merge" && item.arguments.expected_head_sha === pull.headSha && item.sourceFingerprint === fingerprints[index] && !["rejected", "cancelled", "failed"].includes(item.status));
    if (prior && canonicalJson(prior.budgetBinding) !== canonicalJson(budget)) throw new BatchError(`Resolve existing action ${prior.id} before changing its budget-verification mapping.`);
    let executionId = prior?.id ?? null;
    let reason = prior ? `Existing action ${prior.id}: ${prior.status.replaceAll("_", " ")}.` : evaluation.outcome !== "eligible" ? "Policy eligibility requires review; no action prepared." : amount === 0 ? "Not funded within the shared envelope after existing commitments and ranked requests." : "Funded; exact action prepared under the configured approval policy.";
    if (prior) amount = prior.authorizedAmount;
    else if (amount > 0 && evaluation.outcome === "eligible") {
      const key = await sha256({ source: request.source!.externalId.toLowerCase(), head: pull.headSha, intake: fingerprints[index], budget, policy: fingerprint, priorAttempts: data.executions.filter((item) => item.requestId === request.id).length });
      const result = proposeExternalExecution(data, { idempotencyKey: `rr:batch:${key.slice(7)}`, requestId: request.id, actionId: "github.pull_request.merge", resourceId: resource.id, authorizedAmount: amount, sourceFingerprint: fingerprints[index], arguments: { repository_full_name: pull.repositoryFullName, pr_number: pull.number, expected_head_sha: pull.headSha, merge_method: "squash" } });
      data = result.workspace; executionId = result.execution.id;
      if (budget) data.executions.find((item) => item.id === executionId)!.budgetBinding = budget;
    } else { amount = 0; if (budget && simulated.allocated > 0) reason += " The entire verified budget change must be funded."; }
    batch.rows.push({ source: request.source!.externalId, url: pull.htmlUrl, headSha: pull.headSha, requestId: request.id, sourceFingerprint: fingerprints[index], name: request.name, outcome: evaluation.outcome, rank: allocation.rank, simulated: simulated.allocated, authorization: amount, reason, executionId });
  }
  const duplicate = data.batches?.find((item) => item.portfolioFingerprint === fingerprint && canonicalJson(item.rows) === canonicalJson(batch.rows));
  if (duplicate) return { app: { data, undo: app.undo }, batch: duplicate };
  if ((data.batches?.length ?? 0) >= 50) throw new BatchError("Batch history is full. Preserve the audit file before starting a new workspace.");
  data.batches = [...(data.batches ?? []), batch];
  data.activity = [{ id: nextActivityId(data.activity, app.undo), actor: "engine" as const, action: "Connected requests reviewed together", detail: `${batch.id}: ${batch.rows.length} sources validated, full portfolio evaluated under ${batch.policyVersionId}; ${batch.rows.filter((row) => row.executionId).length} actions linked.`, createdAt: batch.createdAt, undoable: false }, ...data.activity].slice(0, WORKSPACE_LIMITS.activity);
  if (!safeWorkspace(data)) throw new BatchError("The batch could not be safely persisted.");
  return { app: { data, undo: app.undo }, batch };
}
