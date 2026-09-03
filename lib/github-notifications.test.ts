import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AppState } from "./cloud-state.ts";
import type { AgentConnection } from "./agent-connections.ts";
import { receiveAgentRequests, decideInboxRequest, requestInboxView } from "./request-inbox.ts";
import { reconcileResourceUsage, resourceLedgerState } from "./domain.ts";
import { authorizedNotification, assertNotificationCurrent, nextNotification, notificationRepository, type BudgetNotification } from "./github-notifications.ts";
import { GitHubIdentityError, verifyGitHubReceipt } from "./github-oidc.ts";
import { confirmAuthorization } from "../integrations/github-confirmation.mjs";

const connection: AgentConnection = { id: "abcdefab-1234-1234-1234-abcdefabcdef", name: "Support", system: "github", resourceId: "credits", maxRequested: 400, createdAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", revokedAt: null };
const repository = "owner/workflows";
async function fixture(approved = true) {
  const app: AppState = { undo: {}, data: { presetId: "custom", policy: { name: "Shared budget", objective: "Compare requests", fields: [{ key: "priority", label: "Priority", type: "integer", min: 1, max: 5 }], outcomes: { eligible: "Eligible", boundary: "Boundary", review: "Review" }, resources: [{ id: "credits", label: "Credits", unit: "credits", capacity: 500, reserve: 0, strategy: "partial", divisible: false }], primaryResourceId: "credits", ranking: [{ source: "field", key: "priority", direction: "desc" }], governance: { owner: "Owner", status: "active", requireApproval: true, requireRationale: true } }, rules: [], cases: [], versions: [], impactReports: [], activity: [], ledger: [], executions: [] } };
  const requests = [5, 3].map((priority, i) => ({ submission_id: `work-${i}`, agent: { id: i ? "other" : connection.id, name: i ? "Research" : "Support" }, source: { system: "github", external_id: `work-${i}` }, name: `Work ${i}`, reason: "Capacity request", resource_id: "credits", requested: 400, minimum: 400, values: { priority } }));
  const result = await receiveAgentRequests(app, requests);
  const view = await requestInboxView(result.app.data), id = view.rows[0].requestId;
  return { app: approved ? await decideInboxRequest(result.app, { request_id: id, decision: "approve", review_fingerprint: view.reviewFingerprint, rationale: "Prioritize support" }, "Owner") : result.app, id, otherId: view.rows[1].requestId };
}
test("notification confirms the existing 400 grant, leaves 100 and never funds research", async () => {
  const { app, id, otherId } = await fixture(), original = structuredClone(app);
  const record = await authorizedNotification(app.data, id, connection, repository);
  assert.equal(record.authorized, 400); assert.equal(record.remaining, 400);
  assert.equal(resourceLedgerState(app.data.policy.resources[0], app.data.ledger).available, 100);
  await assert.rejects(authorizedNotification(app.data, otherId, { ...connection, id: "other" }, repository), /authorization/);
  assert.deepEqual(app, original);
});
test("unapproved, wrong-worker, revoked, expired and invalid-repository notifications fail closed", async () => {
  const pending = await fixture(false), { app, id } = await fixture();
  await assert.rejects(authorizedNotification(pending.app.data, pending.id, connection, repository), /authorization/);
  for (const patch of [{ id: "other" }, { system: "slack" }, { resourceId: "other" }, { revokedAt: new Date().toISOString() }, { expiresAt: "2020-01-01" }]) await assert.rejects(authorizedNotification(app.data, id, { ...connection, ...patch }, repository));
  for (const value of [undefined, "https://github.com/owner/repo", "owner/repo/dispatches", "../repo", "owner/repo?key=x"]) assert.throws(() => notificationRepository(value));
});
test("settled and changed authorizations cannot use an old notification", async () => {
  const { app, id } = await fixture();
  const record = await authorizedNotification(app.data, id, connection, repository);
  assert.throws(() => assertNotificationCurrent(record, { ...record, remaining: 100 }), /changed/);
  assert.throws(() => assertNotificationCurrent({ ...record, expiresAt: "2020-01-01" }, record), /expired/);
  assert.throws(() => assertNotificationCurrent({ ...record, expiresAt: "invalid" }, record), /expired/);
  const consumed = reconcileResourceUsage(app.data, id, "credits", 400, "human", "settle");
  await assert.rejects(authorizedNotification(consumed, id, connection, repository), /authorization/);
});
test("duplicate dispatch is rate-limited; retry retains identity and acknowledgement is terminal", async () => {
  const { app, id } = await fixture();
  const record = await authorizedNotification(app.data, id, connection, repository);
  assert.throws(() => nextNotification(record, record), /pending/);
  const retry = nextNotification(record, { ...record, state: "uncertain", sentAt: new Date(Date.now() - 61000).toISOString() });
  assert.equal(retry.id, record.id); assert.equal(retry.attempt, 2);
  const done: BudgetNotification = { ...record, state: "acknowledged" };
  assert.equal(nextNotification(record, done), done);
});

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig" };
function jwt(claims: object, header = { alg: "RS256", kid: "test-key" }) {
  const input = [header, claims].map((v) => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
  return `${input}.${Buffer.from(sign("RSA-SHA256", Buffer.from(input), pair.privateKey)).toString("base64url")}`;
}
test("GitHub receipt verifies signature, audience, repository, workflow, branch, event and time", async () => {
  const { app, id } = await fixture();
  const record = await authorizedNotification(app.data, id, connection, repository), now = Math.floor(Date.now() / 1000);
  const audience = `https://ruleripple.example/api/agent-notifications/${record.id}`;
  const claims = { iss: "https://token.actions.githubusercontent.com", aud: audience, exp: now + 600, iat: now, nbf: now - 5, repository, ref: "refs/heads/main", event_name: "workflow_dispatch", workflow_ref: `${repository}/.github/workflows/ruleripple-confirmation.yml@refs/heads/main`, run_id: "123456", run_attempt: "1" };
  const fetchKeys: typeof fetch = async (url) => { assert.equal(url, "https://token.actions.githubusercontent.com/.well-known/jwks"); return Response.json({ keys: [jwk] }); };
  const receipt = await verifyGitHubReceipt(jwt(claims), audience, record, fetchKeys);
  assert.equal(receipt.url, "https://github.com/owner/workflows/actions/runs/123456");
  for (const change of [{ iss: "https://evil.example" }, { aud: "other-notification" }, { exp: now - 1 }, { iat: now - 5000 }, { nbf: now + 600 }, { repository: "other/repo" }, { ref: "refs/heads/untrusted" }, { event_name: "pull_request" }, { workflow_ref: `${repository}/.github/workflows/other.yml@refs/heads/main` }, { run_id: "../settings" }]) await assert.rejects(verifyGitHubReceipt(jwt({ ...claims, ...change }), audience, record, fetchKeys), /identity/);
  await assert.rejects(verifyGitHubReceipt(jwt(claims, { alg: "none", kid: "test-key" }), audience, record, fetchKeys), /identity/);
  const valid = jwt(claims), altered = `${valid.slice(0, valid.lastIndexOf(".") + 1)}AAAA`;
  await assert.rejects(verifyGitHubReceipt(altered, audience, record, fetchKeys), /identity/);
  await assert.rejects(verifyGitHubReceipt(valid, audience, { ...record, sentAt: "invalid" }, fetchKeys), (e: unknown) => e instanceof GitHubIdentityError && e.stage === "TIME");
  await assert.rejects(verifyGitHubReceipt(valid, audience, record, fetchKeys, NaN), (e: unknown) => e instanceof GitHubIdentityError && e.stage === "TIME");
});

test("signing-key failures are distinguished without leaking tokens, bodies, or headers", async () => {
  const { app, id } = await fixture(), record = await authorizedNotification(app.data, id, connection, repository);
  const token = jwt({ aud: "private-audience" });
  const failures: [string, typeof fetch][] = [
    ["KEY_FETCH", async () => { throw new Error("SECRET_NETWORK_DETAILS"); }],
    ["KEY_HTTP_503", async () => new Response("SECRET_PROVIDER_BODY", { status: 503 })],
    ["KEY_HTTP_302", async () => new Response(null, { status: 302, headers: { location: "https://evil.example/keys" } })],
    ["KEY_FORMAT", async () => new Response("SECRET_INVALID_JSON")],
    ["KEY_FORMAT", async () => Response.json({ keys: null })],
    ["KEY_MATCH", async () => Response.json({ keys: [{ ...jwk, kid: "another-key" }] })],
  ];
  for (const [stage, fetchKeys] of failures) await assert.rejects(verifyGitHubReceipt(token, "private-audience", record, async (url, options) => {
    assert.equal(url, "https://token.actions.githubusercontent.com/.well-known/jwks");
    assert.equal(options?.redirect, "manual");
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("accept"), "application/json");
    assert.ok(headers.get("user-agent")); assert.equal(headers.get("authorization"), null);
    return fetchKeys(url, options);
  }), (error: unknown) => error instanceof GitHubIdentityError && error.stage === stage && !error.message.includes("SECRET") && !error.message.includes(token));
});

test("confirmation worker reads saved authorization before requesting proof and acknowledging", async () => {
  const id = "a".repeat(64), calls: string[] = [], origin = "https://ruleripple.example";
  const result = await confirmAuthorization({ origin, credential: "rragent1.test", notificationId: id, getIdentity: async (audience: string) => { assert.equal(audience, `${origin}/api/agent-notifications/${id}`); calls.push("proof"); return "secret-proof"; }, fetchImpl: async (_url, options) => {
    calls.push(options!.method!);
    if (options!.method === "GET") return Response.json({ notification: { id, requestId: "RQ-1", authorized: 400, remaining: 400 }, audience: `${origin}/api/agent-notifications/${id}`, executionPermitted: false });
    assert.deepEqual(JSON.parse(String(options!.body)), { notification_id: id, github_identity: "secret-proof" });
    return Response.json({ acknowledged: true, duplicate: false, executionAttempted: false });
  } });
  assert.deepEqual(calls, ["GET", "proof", "POST"]); assert.equal(result.remainingAuthorization, 400); assert.equal(result.executionAttempted, false); assert.ok(!JSON.stringify(result).includes("secret-proof"));
});
test("other worker skips, stale grants stop, and provider bodies or credentials never appear in errors", async () => {
  const args = { origin: "https://ruleripple.example", credential: "rragent1.test", notificationId: "a".repeat(64), getIdentity: async () => { assert.fail("must not obtain identity for unauthorized work"); } };
  const result = await confirmAuthorization({ ...args, fetchImpl: async () => new Response(null, { status: 404 }) });
  assert.equal(result.skipped, true);
  await assert.rejects(confirmAuthorization({ ...args, pause: async () => {}, fetchImpl: async () => new Response("SECRET", { status: 403 }) }), (e: Error) => e.message.includes("403") && !e.message.includes("SECRET"));
  await assert.rejects(confirmAuthorization({ ...args, origin: "https://evil@site.example", fetchImpl: async () => { assert.fail("must not send"); } }));
});

test("a transient acknowledgement retry reuses the same proof and never grants or executes", async () => {
  const id = "b".repeat(64), origin = "https://ruleripple.example", bodies: unknown[] = [];
  let proofCalls = 0;
  const result = await confirmAuthorization({ origin, credential: "rragent1.test", notificationId: id, pause: async () => {}, getIdentity: async () => { proofCalls++; return "PRIVATE_PROOF"; }, fetchImpl: async (_url, options) => {
    if (options?.method === "GET") return Response.json({ notification: { id, requestId: "RQ-2", authorized: 400, remaining: 400 }, audience: `${origin}/api/agent-notifications/${id}`, executionPermitted: false });
    bodies.push(JSON.parse(String(options?.body)));
    return bodies.length === 1 ? new Response(null, { status: 409 }) : Response.json({ acknowledged: true, duplicate: true, executionAttempted: false });
  } });
  assert.equal(proofCalls, 1); assert.equal(bodies.length, 2); assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(Object.keys(bodies[0] as object).sort(), ["github_identity", "notification_id"]);
  assert.equal(result.duplicate, true); assert.equal(result.executionAttempted, false);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_PROOF"));
});

test("receipt errors log only allowlisted diagnostics and never a raw server response", async () => {
  const id = "c".repeat(64), origin = "https://ruleripple.example";
  for (const error of ["GITHUB_IDENTITY_KEY_HTTP_403", "SECRET_RESPONSE_BODY"]) {
    await assert.rejects(confirmAuthorization({ origin, credential: "rragent1.test", notificationId: id, getIdentity: async () => "PRIVATE_PROOF", fetchImpl: async (_url, options) => options?.method === "GET" ? Response.json({ notification: { id, requestId: "RQ-3", authorized: 400, remaining: 400 }, audience: `${origin}/api/agent-notifications/${id}`, executionPermitted: false }) : Response.json({ error }, { status: 403 }) }), (e: Error) => e.message.includes("403, POST") && !e.message.includes("SECRET") && !e.message.includes("PRIVATE_PROOF") && (error.startsWith("GITHUB_IDENTITY") ? e.message.includes(error) : true));
  }
});
