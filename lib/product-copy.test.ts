import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Detailed documentation is local-only; validate the files shipped in a checkout.
const publishedDocuments = ["README.md"];

async function productSourceFiles(directory: "app" | "lib") {
  const root = new URL(`../${directory}/`, import.meta.url);
  const rootPath = fileURLToPath(root);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(?:css|ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts"))
    .map((entry) => [directory, relative(rootPath, entry.parentPath), entry.name].filter(Boolean).join("/"));
}

test("product surfaces do not use demo framing or expose internal fixture language", async () => {
  const productSurfaces = [...publishedDocuments, ...await productSourceFiles("app"), ...await productSourceFiles("lib")];
  for (const path of productSurfaces) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\b(?:demo|demonstration|sample|judge|hackathon)\b/i, path);
    assert.doesNotMatch(source, /\bfictional[- ](?:request|scenario|policy|resource|project|input|cohort|fixture)s?\b/i, path);
    assert.doesNotMatch(source, /Open a blank workspace/i, path);
    assert.doesNotMatch(source, /original capacity|were not imported/i, path);
  }
});

test("shipped modules contain no populated starter portfolio or obsolete fixture migration", async () => {
  const domain = await readFile(new URL("../lib/domain.ts", import.meta.url), "utf8");
  const presets = await readFile(new URL("../lib/presets.ts", import.meta.url), "utf8");
  const cloud = await readFile(new URL("../lib/cloud-state.ts", import.meta.url), "utf8");
  assert.doesNotMatch(domain, /export const default(?:Cases|Workspace|Rules|Versions|Activity)/);
  assert.doesNotMatch(presets, /function request\(|const \w+Cases\s*=|const \w+Rules\s*=/);
  assert.doesNotMatch(cloud, /migratePristinePreloadedScenario/);
});

test("workspace portability is presented as a real audit export", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Download workspace|Snapshot downloaded|Guest workspace|Unsaved workspace/i);
  assert.match(source, /Export audit file/);
  assert.match(source, /ruleripple-audit-export/);
  assert.match(source, /policy, requests, reports, allocations, and ledger/);
});

test("live simulation is not presented as a manually recorded run", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Record run|record when ready|recorded run/i);
  assert.match(source, /Live deterministic preview · current inputs/);
});

test("version comparison disambiguates snapshots with repeated labels", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /\{version\.id\} · \{version\.label\}/);
});

test("saved versions and ledger execution are not exposed as reversible activity", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /saved`, rationale, false/);
  assert.match(source, /"Usage reconciled"[\s\S]{0,300}, false\)/);
  assert.match(source, /saved history and execution are retained/);
});

test("execution evidence cannot be silently reset or leave capacity stranded", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /Schema replacement is blocked after execution evidence exists/);
  assert.match(source, /Revoke if not invoked/);
  assert.match(source, /Revoke only if no connected operator or external agent has invoked GitHub/);
  assert.match(source, /appends a cancellation to the audit ledger/);
  assert.match(source, /Usage at receipt:/);
  assert.match(source, /Recorded authorization:/);
  assert.match(source, /Current request accounting:/);
  assert.match(source, /accounting\.requestTotals\.committed/);
  assert.doesNotMatch(source, /committed to this approved action\./);
  assert.match(source, /was committed when this action completed/);
});

test("product claims do not overstate ledger immutability", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.doesNotMatch(source, /immutable ledger|execution evidence is immutable/i);
  assert.doesNotMatch(readme, /→ immutable ledger/i);
  assert.match(readme, /append-only through RuleRipple's governed workflows/);
  assert.match(readme, /not cryptographically immutable/);
});

test("dynamic counts use singular-aware product copy", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /execution record\{data\.ledger\.length === 1 \? "" : "s"\}/);
  for (const stale of [
    /\{data\.ledger\.length\} execution records/,
    /\{data\.versions\.length\} full snapshots/,
    /\{scenarioDeltas\.length\} decision changes/,
    /\{scenarioGapCount\} eligible capacity gaps/,
    /\{errors\} errors · \{warnings\} warnings/,
    /\{report\.outcomeChanges\}<\/strong> outcomes changed/,
  ]) assert.doesNotMatch(source, stale);
  assert.match(source, /report\.resources\.filter\(\(resource\) => Math\.abs\(resource\.before\)/);
  assert.match(source, /data\.cases\.length === 1 \? "its" : "their"/);
  assert.doesNotMatch(source, /request\$\{saved\.length === 1 \? "" : "s"\} update/);
  assert.match(source, /Add or update \$\{countNoun\(saved\.length, "request"\)\}/);
});

test("approval copy reflects the configured governance mode", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const workflows = await readFile(new URL("../lib/agent-workflow.ts", import.meta.url), "utf8");
  const webmcp = await readFile(new URL("../lib/webmcp-tools.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Human approval still applies|You approve policy changes and execution/);
  assert.match(source, /Configurable<\/strong> approval/);
  assert.match(source, /policy decides when a human checkpoint is required/);
  assert.match(source, /policy-authorized automatically/);
  assert.doesNotMatch(workflows, /remaining credit allocation|Explain credits/i);
  assert.doesNotMatch(webmcp, /credits_authorized|remaining credit allocation/i);
  assert.match(source, /The policy controls authorization/);
});

test("operator UI explains the exact intake and connected execution boundary", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /Exact Markdown structure/);
  assert.match(source, /Copy template/);
  assert.match(source, /one dedicated/);
  assert.match(source, /Source fingerprint/);
  assert.match(source, /public repositories and basic account identity/);
  assert.match(source, /GitHub pull-request merge is the currently implemented built-in action/);
  assert.match(source, /contract is provider-neutral/);
  assert.match(source, /Native action adapters for these systems are not available yet/);
  assert.match(source, /Other systems · not yet built in/);
  assert.doesNotMatch(source, /Adapter-ready|Not required for batch review/);
  assert.match(source, /\/connectors\/github\.svg/);
  for (const connector of ["jira", "slack", "microsoft-teams"]) assert.ok(source.includes(`"${connector}"`));
  assert.match(source, /scoped authentication, typed arguments, authorization checks, and an attributable receipt/);
});

test("assistant is reachable across pages without weakening action authorization", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const assistant = await readFile(new URL("../app/policy-assistant.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-controls="workspace-assistant"/);
  assert.match(source, /className="assistant-dock"/);
  assert.match(source, /className="assistant-mobile"/);
  assert.match(source, /useState\(true\)/);
  assert.match(source, /setOperatorReadOnly\(true\)/);
  assert.match(source, /setSubmittedPrompt\(""\)/);
  assert.match(assistant, /Review portfolio · read-only/);
  assert.match(assistant, /No changes, approvals, or execution/);
  assert.match(assistant, /May import inputs and execute an exact action if the active policy authorizes it/);
  assert.match(assistant, /disabled=\{busy \|\| stale\}/);
  assert.match(assistant, /Each instruction starts a new review/);
  assert.match(assistant, /raw pull-request body does not/);
});

test("rate-window templates do not imply an unconfirmed daily period", async () => {
  const source = await readFile(new URL("../lib/presets.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Daily API quota|daily API-call quota|Per-team daily cap/);
  assert.match(source, /explicitly configured rate window/);
});

test("inbox labels distinguish settled grants and require an explicit decision", async () => {
  const source = await readFile(new URL("../app/request-inbox-view.tsx", import.meta.url), "utf8");
  assert.match(source, /Original authorization/);
  assert.match(source, /remainingAuthorization/);
  assert.match(source, /Usage reconciled/);
  assert.match(source, /decision !== "approve" && decision !== "reject"/);
  assert.match(source, /inbox-field-schema/);
});
