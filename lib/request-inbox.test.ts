import assert from "node:assert/strict";
import test from "node:test";
import { assertInboxUnchanged, decideInboxRequest, parseAgentRequest, receiveAgentRequests, requestInboxView, type AgentRequestInput } from "./request-inbox.ts";
import { appendLedgerEvent, reconcileResourceUsage, resourceLedgerState, safeWorkspace } from "./domain.ts";
import { safeAppState, type AppState } from "./cloud-state.ts";
import { reviewRequestBatch } from "./operator-batch.ts";
import type { GitHubPullRequest } from "./github-server.ts";
import { createWebMCPTools, type WebMCPActions } from "./webmcp-tools.ts";

function workspace(capacity = 10000): AppState {
  return { undo: {}, data: { presetId: "custom", policy: { name: "Shared agent budget", objective: "Authorize competing requests within one resource envelope.", fields: [{ key: "priority", label: "Priority", type: "integer", min: 1, max: 5 }], outcomes: { eligible: "Eligible", boundary: "Boundary", review: "Review" }, resources: [{ id: "credits", label: "Workflow credits", unit: "credits", capacity, reserve: 0, strategy: "partial", divisible: false }], primaryResourceId: "credits", ranking: [{ source: "field", key: "priority", direction: "desc" }], governance: { owner: "Operations", status: "active", requireApproval: true, requireRationale: true } }, rules: [], cases: [], versions: [], impactReports: [], activity: [], ledger: [], executions: [] } };
}
function incoming(id: string, priority: number, requested = 6000, minimum = requested): AgentRequestInput {
  return { submission_id: `delivery-${id}`, agent: { id, name: `Agent ${id}` }, source: { system: "agent", external_id: `work-${id}` }, name: `Process work ${id}`, reason: "Additional capacity is needed for queued work.", resource_id: "credits", requested, minimum, values: { priority } };
}
async function approve(app: AppState, requestId: string) {
  return decideInboxRequest(app, { request_id: requestId, decision: "approve", review_fingerprint: (await requestInboxView(app.data)).reviewFingerprint, rationale: "Prioritize this eligible request within the shared envelope." }, "Workspace owner");
}

test("two agents push source-neutral requests without URLs, GitHub or external execution", async () => {
  const initial = workspace();
  const result = await receiveAgentRequests(initial, [incoming("support", 5), incoming("research", 3)]);
  assert.equal(initial.data.cases.length, 0);
  assert.equal(result.app.data.ledger.length, 0);
  assert.equal(result.app.data.executions.length, 0);
  const view = await requestInboxView(result.app.data);
  assert.deepEqual(view.rows.map((row) => [row.agent.id, row.proposed, row.status]), [["support", 6000, "pending_approval"], ["research", 0, "waiting_for_budget"]]);
  assert.equal(view.portfolioCount, 2);
  assert.deepEqual(safeAppState(JSON.parse(JSON.stringify(result.app)))?.data.inbox, result.app.data.inbox);
});
test("delivery order does not rank agents; duplicate retry adds no requests or ledger events", async () => {
  const forward = await receiveAgentRequests(workspace(), [incoming("support", 5), incoming("research", 3)]);
  const reverse = await receiveAgentRequests(workspace(), [incoming("research", 3), incoming("support", 5)]);
  const compact = async (app: AppState) => (await requestInboxView(app.data)).rows.map(({ requestId, rank, proposed }) => ({ requestId, rank, proposed }));
  assert.deepEqual(await compact(forward.app), await compact(reverse.app));
  const retry = await receiveAgentRequests(forward.app, [incoming("support", 5)]);
  assert.equal(retry.received.length, 0); assert.equal(retry.duplicates.length, 1);
  assert.deepEqual(retry.app, forward.app);
  await assert.rejects(receiveAgentRequests(forward.app, [{ ...incoming("support", 5), requested: 7000 }]), /already used/);
});
test("partial allocations obey the agent's minimum and configured units", async () => {
  const result = await receiveAgentRequests(workspace(), [incoming("support", 5), incoming("research", 3, 6000, 3000)]);
  assert.deepEqual((await requestInboxView(result.app.data)).rows.map((row) => row.proposed), [6000, 4000]);
  assert.throws(() => parseAgentRequest(incoming("fractional", 1, 1.5, 0), workspace().data), /whole/);
});
test("budget approval reserves once and never fabricates consumption or an external receipt", async () => {
  const received = await receiveAgentRequests(workspace(), [incoming("support", 5), incoming("research", 3)]);
  const id = (await requestInboxView(received.app.data)).rows[0].requestId;
  const approved = await approve(received.app, id);
  assert.equal(approved.data.ledger.length, 1);
  assert.equal(approved.data.ledger[0].type, "reserve");
  const ledger = resourceLedgerState(approved.data.policy.resources[0], approved.data.ledger);
  assert.equal(ledger.reserved, 6000); assert.equal(ledger.available, 4000); assert.equal(ledger.consumed, 0);
  assert.equal(approved.data.executions.length, 0);
  await assert.rejects(approve(approved, id), /already has/);
  assert.ok(safeWorkspace(approved.data));
});
test("new arrivals invalidate an open approval and cannot claw back existing commitments", async () => {
  const first = await receiveAgentRequests(workspace(), [incoming("research", 3)]);
  const oldView = await requestInboxView(first.app.data);
  const second = await receiveAgentRequests(first.app, [incoming("support", 5)]);
  await assert.rejects(decideInboxRequest(second.app, { request_id: oldView.rows[0].requestId, decision: "approve", review_fingerprint: oldView.reviewFingerprint, rationale: "Old view." }, "Owner"), /portfolio changed/);
  const committed = await approve(first.app, oldView.rows[0].requestId);
  const after = await receiveAgentRequests(committed, [incoming("support", 5)]);
  const view = await requestInboxView(after.app.data);
  assert.equal(view.rows.find((row) => row.agent.id === "research")?.authorized, 6000);
  assert.equal(view.rows.find((row) => row.agent.id === "support")?.proposed, 0);
});
test("automatic mode evaluates the delivered group together and reserves only funded requests", async () => {
  const app = workspace(); app.data.policy.governance!.requireApproval = false;
  const result = await receiveAgentRequests(app, [incoming("research", 3), incoming("support", 5)]);
  const view = await requestInboxView(result.app.data);
  assert.equal(view.rows[0].status, "approved"); assert.equal(view.rows[0].authorized, 6000);
  assert.equal(view.rows[1].status, "waiting_for_budget");
  assert.equal(result.app.data.inbox?.find((item) => item.decision)?.decision?.by, "Active policy");
  const repeat = await receiveAgentRequests(result.app, [incoming("support", 5)]);
  assert.equal(repeat.app.data.ledger.length, 1);
});
test("declining a request makes its unreserved share available to the next agent", async () => {
  const received = await receiveAgentRequests(workspace(), [incoming("support", 5), incoming("research", 3)]);
  const view = await requestInboxView(received.app.data);
  const declined = await decideInboxRequest(received.app, { request_id: view.rows[0].requestId, decision: "reject", review_fingerprint: view.reviewFingerprint, rationale: "This work is no longer required." }, "Workspace owner");
  const next = await requestInboxView(declined.data);
  assert.equal(next.rows.find((row) => row.agent.id === "research")?.proposed, 6000);
  assert.equal(next.rows.find((row) => row.agent.id === "support")?.status, "rejected");
  assert.equal(declined.data.ledger.length, 0);
  assert.equal(next.portfolioCount, 1);
  const granted = await approve(declined, next.rows.find((row) => row.agent.id === "research")!.requestId);
  assert.equal(granted.data.ledger[0].amount, 6000);
  assert.ok(safeWorkspace(granted.data));
});
test("invalid members abort the delivery; declared scores cannot bypass validation", async () => {
  const app = workspace();
  for (const bad of [{ ...incoming("b", 6) }, { ...incoming("b", 4), minimum: 7000 }, { ...incoming("b", 4), values: { priority: 4, score: 999 } }, { ...incoming("b", 4), decision: "approved" }, { ...incoming("b", 4), source: { system: "agent", external_id: "b", url: "javascript:alert(1)" } }]) await assert.rejects(receiveAgentRequests(app, [incoming("a", 5), bad]));
  assert.equal(app.data.cases.length, 0);
  await assert.rejects(receiveAgentRequests(app, Array(26).fill(incoming("a", 5))), /one and 25/);
});
test("expired policy retains incoming requests but cannot approve or auto-reserve", async () => {
  const app = workspace(); app.data.policy.governance!.effectiveUntil = "2020-01-01"; app.data.policy.governance!.requireApproval = false;
  const result = await receiveAgentRequests(app, [incoming("a", 5)]);
  assert.equal((await requestInboxView(result.app.data)).rows[0].status, "blocked");
  assert.equal(result.app.data.ledger.length, 0);
  await assert.rejects(approve(result.app, result.received[0]), /not eligible/);
});
test("received inputs, decisions, reservation records and policy evidence cannot be rewritten", async () => {
  const result = await receiveAgentRequests(workspace(), [incoming("a", 5)]);
  const approved = await approve(result.app, result.received[0]);
  for (const mutate of [
    (app: AppState) => { app.data.inbox = []; },
    (app: AppState) => { app.data.cases[0].demands.credits = 9000; },
    (app: AppState) => { app.data.inbox![0].decision!.amount = 9000; },
    (app: AppState) => { app.data.versions[0].snapshot.policy.resources[0].capacity = 100000; },
    (app: AppState) => { app.data.ledger[0].amount = 1; },
  ]) { const changed = structuredClone(approved); mutate(changed); assert.throws(() => assertInboxUnchanged(approved.data, changed.data)); }
  assert.doesNotThrow(() => assertInboxUnchanged(approved.data, approved.data));
  const wrong = structuredClone(approved); wrong.data.inbox![0].decision!.amount = 9000; assert.equal(safeWorkspace(wrong.data), null);
});
test("a non-GitHub system uses the same inbox contract without pretending its adapter is installed", async () => {
  const request = incoming("triage", 4); request.source = { system: "slack", external_id: "channel-thread-123" };
  const result = await receiveAgentRequests(workspace(), [request]);
  const view = await requestInboxView(result.app.data);
  assert.equal(view.rows[0].source.system, "slack"); assert.equal(view.rows[0].adapter, null);
  assert.equal(result.app.data.executions.length, 0);
});
test("GitHub is optional execution evidence for an already-received request", async () => {
  const request = incoming("support", 5); request.source = { system: "github", external_id: "org/config#1", url: "https://github.com/org/config/pull/1" }; request.execution = { adapter: "github", reference: "org/config#1" };
  const received = await receiveAgentRequests(workspace(), [request, incoming("research", 3)]);
  assert.equal(received.app.data.executions.length, 0);
  await assert.rejects(approve(received.app, received.received[0]), /source adapter/);
  const pull: GitHubPullRequest = { repositoryFullName: "org/config", number: 1, title: request.name, body: "## Policy intake\n- Priority: 5\n- Requested credits: 6000\n- Minimum useful allocation: 6000", state: "open", draft: false, mergeable: true, merged: false, mergedSha: null, headSha: "1".repeat(40), baseSha: "a".repeat(40), headRef: "change", baseRef: "main", htmlUrl: request.source.url!, author: "agent" };
  const reviewed = await reviewRequestBatch(received.app, [{ reference: request.execution.reference }], async () => ({ pull }));
  assert.equal(reviewed.app.data.cases.length, 2); assert.equal(reviewed.app.data.inbox?.length, 2);
  assert.equal(reviewed.app.data.executions.length, 1); assert.equal(reviewed.app.data.executions[0].authorizedAmount, 6000);
  assert.equal(reviewed.app.data.ledger.length, 0);
  const view = await requestInboxView(reviewed.app.data);
  assert.equal(view.rows[0].authorized, 0);
  assert.equal(view.rows[0].prepared, 6000);
  const changedPolicy = structuredClone(reviewed.app.data);
  changedPolicy.policy.resources[0].capacity = 9000;
  const staleView = await requestInboxView(changedPolicy);
  assert.equal(staleView.rows[0].status, "stale");
  assert.equal(staleView.rows[0].prepared, 0);
  for (const status of ["rejected", "cancelled", "failed"] as const) {
    const historical = structuredClone(reviewed.app.data);
    historical.executions[0].status = status;
    const history = await requestInboxView(historical);
    assert.equal(history.rows[0].status, status);
    assert.equal(history.rows[0].executionId, historical.executions[0].id);
    assert.equal(history.rows[0].authorized, 0);
  }
  assert.doesNotThrow(() => assertInboxUnchanged(received.app.data, reviewed.app.data));
  await assert.rejects(reviewRequestBatch(received.app, [{ reference: request.execution.reference }], async () => ({ pull: { ...pull, body: pull.body.replace("Priority: 5", "Priority: 1") } })), /does not match/);
});

test("an exact retry cannot trigger a new automatic approval after a policy change", async () => {
  const received = await receiveAgentRequests(workspace(), [incoming("a", 5)]);
  received.app.data.policy.governance!.requireApproval = false;
  const retry = await receiveAgentRequests(received.app, [incoming("a", 5)]);
  assert.deepEqual(retry.app, received.app);
  assert.equal(retry.app.data.ledger.length, 0);
});

test("a granted agent can reconcile real usage after a higher-priority arrival, without regaining released budget", async () => {
  const received = await receiveAgentRequests(workspace(), [incoming("research", 3)]);
  const id = received.received[0];
  const granted = await approve(received.app, id);
  const next = await receiveAgentRequests(granted, [incoming("support", 5)]);
  const reconciled = reconcileResourceUsage(next.app.data, id, "credits", 5000, "human", "usage-1");
  const balance = resourceLedgerState(reconciled.policy.resources[0], reconciled.ledger);
  assert.equal(balance.consumed, 5000); assert.equal(balance.reserved, 0); assert.equal(balance.available, 5000);
  assert.throws(() => reconcileResourceUsage(reconciled, id, "credits", 6000, "human", "usage-2"), /Released budget/);
  assert.throws(() => appendLedgerEvent(reconciled, { requestId: id, resourceId: "credits", type: "reserve", amount: 1, actor: "human", note: "More capacity", idempotencyKey: "extra-grant" }), /budget decision|request inbox/);
});

test("WebMCP incoming decisions paginate long provenance without truncating records", async () => {
  const requests = Array.from({ length: 5 }, (_, index) => ({ ...incoming(String(index), 5), reason: "r".repeat(500), source: { system: "agent", external_id: String(index), url: `https://example.com/${"p".repeat(470)}` } }));
  const received = await receiveAgentRequests(workspace(), requests);
  const tool = createWebMCPTools(() => ({ getData: () => received.app.data, actions: {} as WebMCPActions })).find((tool) => tool.name === "get_request_inbox")!;
  const seen: string[] = []; let offset: number | null = 0;
  while (offset !== null) {
    const response = await tool.execute({ limit: 5, offset }) as { content: { text: string }[] };
    const page = JSON.parse(response.content[0].text);
    assert.ok(response.content[0].text.length < 3950); assert.equal(page.truncated, undefined);
    assert.ok(page.requests.length > 0); seen.push(...page.requests.map((row: { requestId: string }) => row.requestId)); offset = page.next_offset;
  }
  assert.equal(new Set(seen).size, 5); assert.equal(seen.length, 5);
});

test("released budget funds waiting agents without reopening a completed grant", async () => {
  const received = await receiveAgentRequests(workspace(), [incoming("support", 5), incoming("research", 3)]);
  const granted = await approve(received.app, received.received[0]);
  granted.data = reconcileResourceUsage(granted.data, received.received[0], "credits", 1000, "human", "finish-support");
  const view = await requestInboxView(granted.data);
  assert.equal(view.rows.find((row) => row.agent.id === "support")?.proposed, 0);
  assert.equal(view.rows.find((row) => row.agent.id === "research")?.proposed, 6000);
  assert.match(view.rows.find((row) => row.agent.id === "research")!.explanation, /6000 credits available/);
  assert.match(view.rows.find((row) => row.agent.id === "support")!.explanation, /1000 consumed/);
  const next = await approve(granted, received.received[1]);
  const balance = resourceLedgerState(next.data.policy.resources[0], next.data.ledger);
  assert.equal(balance.reserved, 6000); assert.equal(balance.consumed, 1000); assert.equal(balance.available, 3000);
});

test("inbox consumers can distinguish original authorization from remaining capacity", async () => {
  const received = await receiveAgentRequests(workspace(), [incoming("support", 5)]);
  const granted = await approve(received.app, received.received[0]);
  const open = (await requestInboxView(granted.data)).rows[0];
  assert.equal(open.authorized, 6000);
  assert.equal(open.settled, false);
  assert.deepEqual(open.accounting, { reserved: 6000, committed: 0, consumed: 0, remainingAuthorization: 6000 });
  granted.data = reconcileResourceUsage(granted.data, received.received[0], "credits", 1000, "human", "settle-support");
  const settled = (await requestInboxView(granted.data)).rows[0];
  assert.equal(settled.authorized, 6000); // Historical approval is retained.
  assert.equal(settled.proposed, 0);
  assert.equal(settled.settled, true);
  assert.deepEqual(settled.accounting, { reserved: 0, committed: 0, consumed: 1000, remainingAuthorization: 0 });
});

test("GitHub verification preserves received source identity and attribution", async () => {
  const request = incoming("support", 5);
  request.source = { system: "github", external_id: "org/config#1", url: "https://github.com/org/config/pull/1" };
  request.execution = { adapter: "github", reference: "org/config#1" };
  const received = await receiveAgentRequests(workspace(), [request]);
  const pull: GitHubPullRequest = { repositoryFullName: "Org/Config", number: 1, title: request.name, body: "## Policy intake\n- Priority: 5\n- Requested credits: 6000\n- Minimum useful allocation: 6000", state: "open", draft: false, mergeable: true, merged: false, mergedSha: null, headSha: "1".repeat(40), baseSha: "a".repeat(40), headRef: "change", baseRef: "main", htmlUrl: "https://github.com/Org/Config/pull/1", author: "agent" };
  const reviewed = await reviewRequestBatch(received.app, [{ reference: "org/config#1" }], async () => ({ pull }));
  assert.deepEqual(reviewed.app.data.cases[0], received.app.data.cases[0]);
  assert.doesNotThrow(() => assertInboxUnchanged(received.app.data, reviewed.app.data));
  assert.equal(reviewed.app.data.executions.length, 1);
});

test("existing commitments do not strand a smaller request behind an unfundable minimum", async () => {
  const first = await receiveAgentRequests(workspace(), [incoming("existing", 1)]);
  const granted = await approve(first.app, first.received[0]);
  const next = await receiveAgentRequests(granted, [incoming("large", 5, 10000, 6000), incoming("small", 3, 2000)]);
  const view = await requestInboxView(next.app.data);
  assert.equal(view.rows.find((row) => row.agent.id === "large")?.proposed, 0);
  assert.equal(view.rows.find((row) => row.agent.id === "small")?.proposed, 2000);
  const final = await approve(next.app, next.received[1]);
  assert.equal(resourceLedgerState(final.data.policy.resources[0], final.data.ledger).reserved, 8000);
});
