import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { assertActiveConnection, issueAgentCredential, newAgentConnection, openAgentCredential, ownAgentDecisions, scopeAgentRequests } from "./agent-connections.ts";
import { receiveAgentRequests, requestInboxView, decideInboxRequest } from "./request-inbox.ts";
import type { AppState } from "./cloud-state.ts";

const secret = "ab".repeat(32), audience = "https://ruleripple.example", now = Date.now();
function workspace(): AppState {
  return { undo: {}, data: { presetId: "custom", policy: { name: "Shared budget", objective: "Authorize competing requests.", fields: [{ key: "priority", label: "Priority", type: "integer", min: 1, max: 5 }], outcomes: { eligible: "Eligible", boundary: "Boundary", review: "Review" }, resources: [{ id: "credits", label: "Credits", unit: "credits", capacity: 1500, reserve: 0, strategy: "partial", divisible: false }], primaryResourceId: "credits", ranking: [{ source: "field", key: "priority", direction: "desc" }], governance: { owner: "Operations", status: "active", requireApproval: true, requireRationale: true } }, rules: [], cases: [], versions: [], impactReports: [], activity: [], ledger: [], executions: [] } };
}
const settings = { name: "Support", system: "internal", resourceId: "credits", maxRequested: 1000, days: 7 };
const incoming = (priority: number, id = "work-1") => ({ submission_id: id, source: { system: "internal", external_id: id }, name: `Process ${id}`, reason: "Capacity for queued work", resource_id: "credits", requested: 1000, minimum: 1000, values: { priority } });
test("sealed credential does not expose owner session and binds audience/expiry", async () => {
  const connection = newAgentConnection(settings, workspace().data, now);
  const issued = await issueAgentCredential(connection, "owner-1", "private-refresh-session", audience, secret);
  assert.ok(!issued.token.includes("private-refresh-session"));
  assert.ok(!JSON.stringify(issued.record).includes("private-refresh-session"));
  const opened = await openAgentCredential(issued.token, audience, secret, now);
  assert.equal(opened.ownerId, "owner-1"); assert.equal(opened.refreshToken, "private-refresh-session");
  await assert.rejects(openAgentCredential(issued.token, "https://different.example", secret, now), /invalid or expired/);
  await assert.rejects(openAgentCredential(issued.token, audience, secret, now + 7 * 86400000), /invalid or expired/);
  await assert.rejects(openAgentCredential(issued.token, audience, "cd".repeat(32), now), /invalid or expired/);
  await assert.rejects(openAgentCredential(issued.token, audience, "", now), /not configured/);
});
test("tampering, truncation, malformed credentials and missing owner sessions fail closed", async () => {
  const connection = newAgentConnection(settings, workspace().data, now);
  const { token } = await issueAgentCredential(connection, "owner", "refresh", audience, secret);
  for (const bad of ["", "rragent1.not-credential", token.slice(0, 50), token.slice(0, 30) + (token[30] === "a" ? "b" : "a") + token.slice(31), token + ".garbage"]) await assert.rejects(openAgentCredential(bad, audience, secret, now));
  await assert.rejects(issueAgentCredential(connection, "owner", "", audience, secret), /current owner session/);
});
test("revocation, wrong fingerprint and changed scope reject otherwise valid credentials", async () => {
  const connection = newAgentConnection(settings, workspace().data, now);
  const { token, record } = await issueAgentCredential(connection, "owner", "refresh", audience, secret);
  await assertActiveConnection(connection, record, token, now);
  await assert.rejects(assertActiveConnection(connection, null, token, now), /revoked/);
  await assert.rejects(assertActiveConnection(connection, { ...record, revokedAt: new Date(now).toISOString() }, token, now), /revoked/);
  await assert.rejects(assertActiveConnection(connection, { ...record, tokenHash: "wrong" }, token, now), /revoked/);
  await assert.rejects(assertActiveConnection(connection, { ...record, maxRequested: 1500 }, token, now), /scope changed/);
});
test("connection setup validates limits, lifetime, resource and identifiers", () => {
  for (const change of [{ name: "" }, { system: "GitHub" }, { resourceId: "elsewhere" }, { maxRequested: 0 }, { maxRequested: 1501 }, { maxRequested: 1.5 }, { days: 365 }, { days: "7" }, { approve: true }]) assert.throws(() => newAgentConnection({ ...settings, ...change }, workspace().data));
});
test("scope stamps identity, namespaces retries and rejects agent impersonation or resource escalation", () => {
  const connection = newAgentConnection(settings, workspace().data);
  const scoped = scopeAgentRequests([incoming(5)], connection, workspace().data)[0];
  assert.deepEqual(scoped.agent, { id: connection.id, name: connection.name });
  assert.equal(scoped.submission_id, `${connection.id}:work-1`);
  for (const change of [{ agent: { id: "other", name: "Other" } }, { requested: 1200 }, { decision: "approved" }, { resource_id: "other" }, { source: { system: "slack", external_id: "work-1" } }, { submission_id: "a".repeat(101) }, { values: { priority: 999 } }]) assert.throws(() => scopeAgentRequests([{ ...incoming(5), ...change }], connection, workspace().data));
});
test("two independent credentials share a budget, preserve retries, and see only their own decisions", async () => {
  const initial = workspace();
  const a = newAgentConnection(settings, initial.data), b = newAgentConnection({ ...settings, name: "Research" }, initial.data);
  const first = await receiveAgentRequests(initial, scopeAgentRequests([incoming(5)], a, initial.data));
  const second = await receiveAgentRequests(first.app, scopeAgentRequests([incoming(3, "work-2")], b, first.app.data));
  const view = await requestInboxView(second.app.data);
  assert.equal(view.rows.length, 2); assert.equal(view.rows[0].proposed, 1000); assert.equal(view.rows[1].proposed, 0);
  const ownA = ownAgentDecisions(view, a), ownB = ownAgentDecisions(view, b);
  assert.equal(ownA.rows.length, 1); assert.equal(ownB.rows.length, 1);
  assert.equal(ownB.rows[0].status, "waiting_for_budget");
  assert.deepEqual(ownAgentDecisions(view, b, first.received[0]).rows, []);
  assert.ok(!JSON.stringify(ownA).includes("work-2"));
  assert.ok(!("reviewFingerprint" in ownA)); assert.ok(!("app" in ownA));
  const retry = await receiveAgentRequests(second.app, scopeAgentRequests([incoming(5)], a, second.app.data));
  assert.deepEqual(retry.app, second.app); assert.equal(retry.duplicates.length, 1); assert.equal(retry.app.data.ledger.length, 0);
  const approved = await decideInboxRequest(second.app, { request_id: first.received[0], decision: "approve", review_fingerprint: view.reviewFingerprint, rationale: "Authorize support first within this shared envelope." }, "Owner");
  const after = ownAgentDecisions(await requestInboxView(approved.data), a);
  assert.equal(after.rows[0].authorized, 1000); assert.equal(after.rows[0].accounting.reserved, 1000); assert.equal(after.rows[0].accounting.consumed, 0);
  assert.equal(approved.data.executions.length, 0);
});
test("scoped routes cannot approve and credential records are separate from exported state", () => {
  const agentRoute = readFileSync(new URL("../app/api/agent-requests/route.ts", import.meta.url), "utf8");
  assert.ok(agentRoute.includes("authenticateAgent(request)")); assert.ok(agentRoute.includes("await assertActive()"));
  assert.ok(!agentRoute.includes("decideInboxRequest")); assert.ok(!agentRoute.includes("executeStoredGitHubAction"));
  const server = readFileSync(new URL("./agent-server.ts", import.meta.url), "utf8");
  assert.ok(server.includes('import "server-only"'));
  assert.ok(server.includes('request.headers.has("authorization")'));
  const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
  assert.ok(rules.includes("match /agentConnections/{connectionId}")); assert.ok(rules.includes("allow update: if false"));
});
