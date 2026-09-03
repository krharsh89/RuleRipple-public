import assert from "node:assert/strict";
import test from "node:test";
import { operatorReadiness } from "./operator-readiness.ts";

const connected = { operator_access: true, operator_access_configured: true, oauth_configured: true, connected: true, model_configured: true, model: "configured model" };
test("batch readiness does not depend on model credentials", () => {
  const result = operatorReadiness({ ...connected, model_configured: false }, true);
  assert.equal(result.batchReady, true);
  assert.equal(result.modelReady, false);
  assert.equal(result.issue, "");
});
test("read-only model review requires an allowed signed-in account but not GitHub", () => {
  const noGitHub = { ...connected, connected: false, oauth_configured: false };
  assert.equal(operatorReadiness(noGitHub, true).reviewReady, true);
  assert.equal(operatorReadiness(noGitHub, true).modelReady, false);
  assert.equal(operatorReadiness(noGitHub, false).reviewReady, false);
  assert.equal(operatorReadiness({ ...noGitHub, operator_access: false }, true).reviewReady, false);
  assert.equal(operatorReadiness({ ...noGitHub, model_configured: false }, true).reviewReady, false);
});
test("signed-in setup failures never instruct the user to sign in again", () => {
  const result = operatorReadiness({ ...connected, operator_access: false, operator_access_configured: false, oauth_configured: false, connected: false }, true);
  assert.equal(result.batchReady, false);
  assert.match(result.issue, /GitHub OAuth and workspace operator access/);
  assert.doesNotMatch(result.issue, /Sign in/);
  assert.equal(result.githubLabel, "Site setup required");
});
test("readiness distinguishes loading, access denial, expiration and signed-out sessions", () => {
  assert.match(operatorReadiness(null, true).issue, /not yet available/);
  assert.match(operatorReadiness({ ...connected, operator_access: false }, true).issue, /not enabled/);
  assert.match(operatorReadiness({ ...connected, connected: false, connection_expired: true }, true).issue, /expired/);
  assert.equal(operatorReadiness(connected, false).batchReady, false);
  assert.match(operatorReadiness(connected, false).issue, /Sign in/);
});
