import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
const firebaseServer = readFileSync(new URL("./firebase-server.ts", import.meta.url), "utf8");
const githubServer = readFileSync(new URL("./github-server.ts", import.meta.url), "utf8");
const operatorEngine = readFileSync(new URL("./operator-engine.ts", import.meta.url), "utf8");
const operatorEngineCore = readFileSync(new URL("./operator-engine-core.ts", import.meta.url), "utf8");
const operatorExecution = readFileSync(new URL("./operator-execution.ts", import.meta.url), "utf8");
const operatorExecutionCore = readFileSync(new URL("./operator-execution-core.ts", import.meta.url), "utf8");
const githubCallback = readFileSync(new URL("../app/api/github/callback/route.ts", import.meta.url), "utf8");
const githubStatus = readFileSync(new URL("../app/api/github/status/route.ts", import.meta.url), "utf8");
const operatorRun = readFileSync(new URL("../app/api/operator/run/route.ts", import.meta.url), "utf8");
const apiRoutes = [
  "auth",
  "session",
  "workspace",
  "github/status",
  "github/disconnect",
  "operator/run",
  "operator/batch",
  "operator/execute",
].map((name) => readFileSync(new URL(`../app/api/${name}/route.ts`, import.meta.url), "utf8"));

test("security policy keeps browser connections on the same origin", () => {
  assert.match(config, /connect-src 'self'/);
  assert.doesNotMatch(config, /connect-src[^\"]+googleapis/);
  assert.doesNotMatch(config, /connect-src[^\"]+\s\*/);
  assert.match(config, /frame-ancestors 'none'/);
  assert.match(config, /object-src 'none'/);
  assert.match(config, /source: "\/api\/:path\*"/);
  assert.match(config, /Cache-Control[^\n]+no-store, max-age=0/);
});

test("private API responses explicitly disable caching", () => {
  assert.match(firebaseServer, /Cache-Control", "no-store, max-age=0"/);
  for (const route of apiRoutes) {
    assert.match(route, /privateJson/);
    assert.doesNotMatch(route, /NextResponse\.json/);
  }
  assert.match(firebaseServer, /decodeURIComponent[\s\S]{0,100}catch \{ return null; \}/);
});

test("state-changing APIs reject missing and cross-origin requests", () => {
  assert.match(firebaseServer, /if \(!origin \|\| origin !== new URL\(request\.url\)\.origin\)/);
  for (const route of apiRoutes) {
    if (/export async function (?:POST|PUT|DELETE)/.test(route)) assert.match(route, /assertSameOrigin\(request\)/);
  }
  assert.match(githubServer, /httpOnly: true/);
  assert.match(githubServer, /boundCookieValue\(cookieValue\(request, ACCESS_COOKIE\), ownerId\)/);
  assert.match(githubCallback, /githubOAuthState\(request, session\.user\.uid\)/);
  assert.match(githubCallback, /clearGitHubAccessToken\(response\)/);
  assert.match(operatorRun, /githubAccessToken\(request, session\.user\.uid\)/);
  assert.match(operatorRun, /input\.prompt\.trim\(\)\.length > 600/);
  assert.match(operatorEngineCore, /const WEBMCP_OPERATOR_TOOLS = \["get_policy_summary", "upsert_cases", "evaluate_cases", "propose_external_execution", "get_external_execution"\]/);
  assert.doesNotMatch(operatorEngineCore, /name: "github_merge_pull_request"/);
  assert.match(operatorRun, /if \(readOnly && \(changed \|\| result.pendingExecutionId\)\)/);
  assert.match(operatorExecution, /writeFirebaseWorkspace[\s\S]+mergeGitHubPullRequest/);
  assert.match(operatorExecution, /existing\.arguments\.expected_head_sha/);

  for (const serverModule of [firebaseServer, githubServer, operatorEngine, operatorExecution]) {
    assert.match(serverModule, /^import "server-only";/);
  }
  assert.doesNotMatch(config, /OPENAI_API_KEY|GITHUB_CLIENT_SECRET|OPERATOR_ALLOWED_EMAILS/);
  assert.doesNotMatch(githubStatus, /GITHUB_CLIENT_SECRET|clientSecret|openaiKey/);
  assert.match(githubStatus, /model_configured: Boolean\(process\.env\.OPENAI_API_KEY\)/);
  assert.doesNotMatch(operatorRun, /privateJson\([^\n]*(?:openaiKey|OPENAI_API_KEY|githubToken|GITHUB_CLIENT_SECRET)/);
});

test("JSON APIs reject malformed, oversized, and incorrectly typed bodies", () => {
  assert.match(firebaseServer, /export async function readJsonObject/);
  assert.match(firebaseServer, /JSON_CONTENT_TYPE_REQUIRED/);
  assert.match(firebaseServer, /REQUEST_BODY_TOO_LARGE/);
  assert.match(firebaseServer, /INVALID_JSON_BODY/);
  for (const route of apiRoutes.filter((source) => /export async function (?:POST|PUT)/.test(source) && /readJsonObject/.test(source))) {
    assert.doesNotMatch(route, /request\.json\(\)/);
  }
});

test("built-in GitHub execution fails closed and pins the inspected intake", () => {
  assert.match(githubServer, /current\.mergeable === null[\s\S]+GITHUB_MERGEABILITY_PENDING/);
  assert.match(githubServer, /current\.mergeable === false[\s\S]+GITHUB_PULL_REQUEST_NOT_MERGEABLE/);
  assert.match(operatorEngineCore, /input\.idempotencyKey !== inspection\.executionIdempotencyKey/);
  assert.match(operatorEngineCore, /sourceFingerprint: inspection\.intakeFingerprint/);
  assert.match(operatorExecution, /assertPinnedIntake/);
  assert.match(operatorExecution, /allowAlreadyMerged: false/);
  assert.match(operatorExecutionCore, /GITHUB_POLICY_INTAKE_CHANGED/);
  assert.match(operatorExecutionCore, /EXECUTION_RECONCILIATION_REQUIRED/);
});

test("every GitHub request identifies RuleRipple to the provider", () => {
  assert.match(githubServer, /const GITHUB_USER_AGENT = "RuleRipple"/);
  assert.equal((githubServer.match(/"user-agent": GITHUB_USER_AGENT/g) ?? []).length, 2);
});
