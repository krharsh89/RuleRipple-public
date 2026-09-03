import assert from "node:assert/strict";
import test from "node:test";
import { runRuleRippleOperatorCore } from "./operator-engine-core.ts";
import { reviewPortfolio } from "./operator-review.ts";
import type { AppState } from "./cloud-state.ts";

function workspace(count = 2): AppState {
  return { undo: {}, data: {
    presetId: "custom", policy: { name: "Workflow budget", objective: "Prioritize approved work", fields: [{ key: "priority", label: "Priority", type: "integer", min: 1, max: 10 }], outcomes: { eligible: "Eligible", boundary: "Boundary", review: "Review" }, resources: [{ id: "credits", label: "Credits", unit: "credits", capacity: 1500, reserve: 0, strategy: "partial", divisible: false }], primaryResourceId: "credits", ranking: [{ source: "field", key: "priority", direction: "desc" }], governance: { owner: "Operations", status: "active", requireApproval: true, requireRationale: true } },
    rules: [], cases: Array.from({ length: count }, (_, index) => ({ id: `C-${index + 1}`, name: `Workflow ${index + 1}`, values: { priority: 10 - index }, demands: { credits: 1000 }, minimums: { credits: 1000 }, actualUsage: {} })),
    versions: [], impactReports: [], activity: [], ledger: [], executions: [],
  } };
}

type Body = { tools: Array<{ name: string; strict: boolean; parameters: { required?: string[] } }>; tool_choice: unknown; instructions: string; input: Array<{ output: string }> };
function model(replies: Array<(body: Body) => unknown>): typeof fetch {
  let index = 0;
  return (async (_url, init) => {
    const reply = replies[index++];
    assert.ok(reply, "Unexpected additional model call");
    return Response.json({ id: `response-${index}`, ...reply(JSON.parse(String(init?.body))) as object });
  }) as typeof fetch;
}
const call = (name: string, args: unknown = {}) => ({ output: [{ type: "function_call", call_id: `call-${name}`, name, arguments: JSON.stringify(args) }] });

test("operator review evaluates every request beyond the WebMCP page limit without IDs", async () => {
  const app = workspace(7); const before = structuredClone(app);
  const result = await runRuleRippleOperatorCore({ app, prompt: "Review the full portfolio", openaiKey: "test-only", fetchImpl: model([
    (body) => {
      assert.deepEqual(body.tool_choice, { type: "function", name: "review_portfolio" });
      const evaluate = body.tools.find((tool) => tool.name === "evaluate_cases")!;
      assert.equal(evaluate.strict, false);
      assert.ok(!evaluate.parameters.required?.includes("case_ids"));
      assert.ok(body.tools.some((tool) => tool.name === "get_resource_ledger"));
      assert.ok(!body.tools.some((tool) => /upsert|propose|github/.test(tool.name)));
      return call("review_portfolio");
    },
    (body) => {
      const report = JSON.parse(body.input[0].output);
      assert.equal(report.totalRequests, 7); assert.equal(report.evaluatedRequests, 7);
      assert.deepEqual(report.requests.map((row: { id: string }) => row.id), app.data.cases.map((row) => row.id));
      assert.equal(report.requests[6].name, "Workflow 7");
      return call("evaluate_cases");
    },
    (body) => {
      const page = JSON.parse(body.input[0].output);
      assert.equal(page.total, 7); assert.equal(page.cases.length, 3); assert.equal(page.next_offset, 3);
      return { output_text: "Seven requests evaluated. Requested demand is not measured usage." };
    },
  ]) });
  assert.equal(result.portfolioReview?.evaluatedRequests, 7);
  assert.match(result.trace[0].detail, /7 of 7/);
  assert.deepEqual(result.app, before); assert.deepEqual(app, before);
  assert.equal(result.pendingExecutionId, null); assert.equal(result.readOnly, true);
});

test("portfolio report separates requested, simulated, committed, consumed and available amounts", () => {
  const app = workspace();
  app.data.ledger = [
    { id: "L-1", idempotencyKey: "reserve", requestId: "C-1", resourceId: "credits", type: "reserve", amount: 1000, actor: "human", createdAt: "2026-09-03T00:00:00Z", note: "Approved" },
    { id: "L-2", idempotencyKey: "commit", requestId: "C-1", resourceId: "credits", type: "commit", amount: 1000, actor: "engine", createdAt: "2026-09-03T00:01:00Z", note: "Executed" },
  ];
  const report = reviewPortfolio(app.data), resource = report.resources[0];
  assert.equal(resource.requestedDemand, 2000);
  assert.equal(resource.simulatedAllocation, 1000);
  assert.equal(resource.ledger.committed, 1000); assert.equal(resource.ledger.consumed, 0); assert.equal(resource.ledger.available, 500);
  assert.equal(report.requests[0].resources[0].additionalAuthorizable, 0);
  assert.equal(report.requests[1].resources[0].additionalAuthorizable, 0);
  assert.match(report.accountingNote, /Zero recorded consumption does not establish zero provider usage/);
  // The same simulation with no ledger must not be called a commitment.
  app.data.ledger = [];
  const uncommitted = reviewPortfolio(app.data).resources[0];
  assert.equal(uncommitted.simulatedAllocation, 1000); assert.equal(uncommitted.ledger.committed, 0);
});

test("read-only mode blocks writes and GitHub even when the model attempts them", async () => {
  const app = workspace(); const before = structuredClone(app); let inspected = false;
  const result = await runRuleRippleOperatorCore({ app, prompt: "Review", readOnly: true, openaiKey: "test-only", inspectPull: async () => { inspected = true; throw Error("Should never run"); }, fetchImpl: model([
    () => call("review_portfolio"),
    () => call("upsert_cases", { cases: [] }),
    (body) => { assert.match(body.input[0].output, /not available/); return call("propose_external_execution"); },
    (body) => { assert.match(body.input[0].output, /not available/); return call("github_get_pull_request", { repository_full_name: "org/repo", pr_number: 1 }); },
    (body) => { assert.match(body.input[0].output, /not available/); return { output_text: "No changes made." }; },
  ]) });
  assert.equal(inspected, false); assert.deepEqual(app, before); assert.deepEqual(result.app, before);
  assert.equal(result.trace.filter((item) => item.status === "blocked").length, 3);
  assert.equal(result.pendingExecutionId, null);
});

test("a model answer without the required portfolio review fails closed", async () => {
  await assert.rejects(runRuleRippleOperatorCore({ app: workspace(), prompt: "Review", openaiKey: "test-only", fetchImpl: model([() => ({ output_text: "Everything is fine." })]) }), /did not complete/);
});

test("empty portfolios are explicitly reported and read-only review needs no GitHub credential", async () => {
  const result = await runRuleRippleOperatorCore({ app: workspace(0), prompt: "Review", openaiKey: "test-only", fetchImpl: model([() => call("review_portfolio"), () => ({ output_text: "No requests yet." })]) });
  assert.equal(result.portfolioReview?.totalRequests, 0); assert.equal(result.pendingExecutionId, null);
  await assert.rejects(runRuleRippleOperatorCore({ app: workspace(), prompt: "Inspect", readOnly: false, openaiKey: "test-only" }), /Connect GitHub/);
});

test("explicit action mode still pins canonical GitHub intake and stops at human approval", async () => {
  const app = workspace(0); const before = structuredClone(app);
  let inspection: { request_input: { case_id: string }; pull_request: { execution_idempotency_key: string } };
  const result = await runRuleRippleOperatorCore({ app, prompt: "Inspect org/config#1", readOnly: false, openaiKey: "test-only", inspectPull: async () => ({ repositoryFullName: "org/config", number: 1, title: "Support workflow", body: "## Policy intake\n- Priority: 5\n- Credits demand: 1000\n- Minimum useful allocation: 1000", state: "open", draft: false, mergeable: true, merged: false, mergedSha: null, headSha: "a".repeat(40), baseSha: "b".repeat(40), headRef: "change", baseRef: "main", htmlUrl: "https://github.com/org/config/pull/1", author: "owner" }), fetchImpl: model([
    (body) => { assert.ok(body.tools.some((tool) => tool.name === "upsert_cases")); return call("github_get_pull_request", { repository_full_name: "org/config", pr_number: 1 }); },
    (body) => { inspection = JSON.parse(body.input[0].output); assert.ok(inspection.request_input); return call("upsert_cases", { cases: [inspection.request_input] }); },
    (body) => { assert.equal(JSON.parse(body.input[0].output).status, "applied"); return call("evaluate_cases", { case_ids: [inspection.request_input.case_id] }); },
    (body) => {
      const evaluated = JSON.parse(body.input[0].output).cases[0];
      assert.equal(evaluated.allocation.resources.credits.allocated, 1000);
      return call("propose_external_execution", { request_id: inspection.request_input.case_id, action_id: "github.pull_request.merge", action_arguments: { repository_full_name: "org/config", pr_number: 1, expected_head_sha: "a".repeat(40), merge_method: "squash" }, resource_id: "credits", authorized_amount: 1000, idempotency_key: inspection.pull_request.execution_idempotency_key });
    },
    (body) => { assert.equal(JSON.parse(body.input[0].output).status, "pending_human_confirmation"); return { output_text: "Waiting for human approval." }; },
  ]) });
  assert.equal(result.readOnly, false); assert.ok(result.pendingExecutionId);
  assert.equal(result.app.data.executions[0].status, "pending_approval");
  assert.equal(result.app.data.ledger.length, 0); assert.deepEqual(app, before);
  const missing = reviewPortfolio(result.app.data).executionUsage[0];
  assert.equal(missing.receiptReportedUsage, null);
});
