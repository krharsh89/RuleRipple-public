# RuleRipple

**See who receives a scarce resource, who does not, and why when one policy rule changes.**

RuleRipple is a browser-native policy control plane for humans and agents. Its Request inbox receives typed budget requests from trusted workers over HTTPS or WebMCP, evaluates the entire portfolio, and reserves capacity only after the configured human or policy authorization. No repository or source URL is required. Nineteen WebMCP tools also expose policy creation, deterministic simulation, full-version comparisons and governed execution. GitHub is an optional execution adapter, not the request model; Slack, Teams and other adapters remain expansion paths. The application—not the model—calculates every outcome, score, rank, allocation and balance.

## Try the live application

Open [ruleripple.krharsh89.chatgpt.site](https://ruleripple.krharsh89.chatgpt.site/) in the ChatGPT in-app browser or a WebMCP-enabled browser. Start a new guest workspace to configure and simulate a policy without an account or provider credentials. Sign-in, cloud persistence, the built-in assistant, and connected execution require the corresponding services described below.

## Testing instructions: guest WebMCP path

This path verifies the browser tools and shared-budget decision without an account, API key, GitHub connection, or access to a private repository.

1. Open the live application in the ChatGPT in-app browser or another WebMCP-enabled browser.
2. Choose **Open new workspace**. Do not sign in.
3. Confirm the header reports **WebMCP ready**. If it reports unavailable, enable WebMCP in the browser or use the ChatGPT in-app browser before continuing.
4. Give the browser agent the instruction below. It must call RuleRipple's tools rather than answer from the text alone.

```text
Use only RuleRipple's WebMCP tools for this task. Start by calling
get_policy_summary. Configure this fresh workspace with create_policy:

- name: Shared agent budget
- objective: Allocate scarce credits across competing agent requests.
- outcomes: eligible "Eligible", boundary "Boundary", review "Review"
- field: integer priority, labelled Priority, minimum 0, maximum 100
- resource: credits, labelled Agent credits, unit credits, capacity 500,
  reserve 0, priority_first_fit, not divisible
- primary resource: credits
- ranking: priority descending, then demand for credits ascending
- boundary: tolerance 0.1, maximum failed rules 0
- scoring: base 50, minimum 0, maximum 100
- governance: owner Workspace owner, active, human approval required,
  rationale required

If RuleRipple presents a policy-change approval, stop so I can approve it.
After the policy is active, use one submit_budget_requests call for these two
requests:

1. submission_id support-001; agent id support-agent; agent name Support agent;
   source system webmcp; external_id guest-flow:support-001; name Support triage;
   reason Handle urgent customer requests; resource credits; requested 400;
   minimum 400; priority 100.
2. submission_id research-001; agent id research-agent; agent name Research agent;
   source system webmcp; external_id guest-flow:research-001; name Research evaluation;
   reason Evaluate a research workflow; resource credits; requested 400;
   minimum 400; priority 50.

Then call get_request_inbox, evaluate_cases, and get_resource_ledger. Explain
the result. Do not approve a request, reserve resources separately, execute an
external action, or claim that any work ran or credits were consumed.
```

5. If a policy-change card appears, review and approve it in the interface, then tell the browser agent to continue with the request portion of the instruction.
6. The tool results must show both requests evaluated together: support ranks first and can receive 400 simulated credits; research receives 0 because the remaining 100 is below its 400-credit minimum. No usage has occurred.
7. Open **Request inbox**, select support's **Review allocation**, enter a rationale such as `Higher priority under the active shared-budget policy`, and approve exactly 400 credits.
8. Read the ledger again. It must show 400 reserved for support, 100 available, research waiting, and 0 recorded consumption. This proves authorization, not execution or spending.

The deterministic engine, rather than the language model, calculates all policy decisions. GitHub delivery over HTTPS is an additional integration path and is not required for this guest WebMCP verification.

## Run locally

Requirements: Node.js 22.13 or newer and pnpm.

```bash
git clone https://github.com/krharsh89/RuleRipple-public.git
cd RuleRipple-public
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm dev
```

Open the local address printed by the development server. Guest policy configuration and simulation work without credentials.

## Configure your own hosted instance

Copy `.env.example` to an ignored `.env.local` file for local development, or define the same names in the host's encrypted secret store. Never commit actual values.

| Setting | Required for | Storage rule |
| --- | --- | --- |
| `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID` | Accounts and durable workspaces | Use your own Firebase web application and deploy `firestore.rules` to that project |
| `OPENAI_API_KEY`, `OPERATOR_ALLOWED_EMAILS` | Built-in policy assistant | Server-side only; allow only intended operator email addresses |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Owner-authorized GitHub inspection and execution | Keep the client secret server-side; set the OAuth callback to `https://YOUR_HOST/api/github/callback` |
| `AGENT_CREDENTIAL_KEY` | Issuing and verifying HTTPS worker credentials | Generate a private 32-byte signing key and store it server-side only |
| `GITHUB_NOTIFICATION_REPOSITORY` | Sending authorization receipts to one GitHub worker repository | Set to an explicitly approved `owner/repository`; this is not a credential |

The checked-in `.openai/hosting.json` and `.firebaserc` intentionally contain no owner project IDs. Connect the checkout to your own Sites and Firebase projects before publishing. The application reads secrets only from its server environment; no actual key, OAuth secret, access token, worker credential, or signing key belongs in source control.

## Reproduce the two-worker GitHub flow

The separate development worker repository is not required. Use any repository you control as the worker repository and install the public templates from this source tree:

| Copy from this repository | Place in the worker repository |
| --- | --- |
| `integrations/agent-worker.mjs` | `scripts/ruleripple-agent.mjs` |
| `integrations/github-actions.yml` | `.github/workflows/ruleripple-requests.yml` |
| `integrations/github-confirmation.mjs` | `scripts/ruleripple-confirmation.mjs` |
| `integrations/github-confirmation.yml` | `.github/workflows/ruleripple-confirmation.yml` |

Then:

1. In RuleRipple, create the policy and resource budget that both workers will share.
2. Under **Request inbox → Connect agents**, create two `github` worker connections. Use the same policy resource, set an adequate per-request limit, and copy each one-time credential immediately.
3. In the worker repository, store those credentials as encrypted GitHub Actions secrets named `RULERIPPLE_AGENT_ONE` and `RULERIPPLE_AGENT_TWO`. Set the non-secret repository variable `RULERIPPLE_ORIGIN` to the origin of your RuleRipple instance.
4. Add `.ruleripple/requests/agent-one.json` and `.ruleripple/requests/agent-two.json`. Each request must use a unique, stable `submission_id`, declare `source.system` as `github`, use a stable `source.external_id`, name the policy resource, and provide values matching the active policy schema. Do not put a credential in either file.
5. Run **Submit agent budget requests** in GitHub Actions. Both jobs authenticate independently and send their requests to RuleRipple, where they compete against the same saved portfolio and existing commitments.
6. Refresh **Request inbox**, inspect the ranks and allocations, and complete the exact human budget approval if the policy requires one.
7. To return a receipt, connect GitHub OAuth in RuleRipple and set `GITHUB_NOTIFICATION_REPOSITORY` to the worker repository. The confirmation workflow rechecks the saved authorization and acknowledges it. It does not run the workload, merge code, or report measured provider usage.

A minimal request document has this shape; the policy-specific `values` must be replaced with fields declared by your policy:

```json
{
  "requests": [
    {
      "submission_id": "worker-one-request-001",
      "source": {
        "system": "github",
        "external_id": "owner/repository:worker-one-request-001"
      },
      "name": "Request a bounded resource allocation",
      "reason": "Explain why this work needs the shared resource.",
      "resource_id": "credits",
      "requested": 400,
      "minimum": 400,
      "values": {}
    }
  ]
}
```

Retries should retain the same `submission_id` and source identity so intake remains idempotent. The ledger distinguishes requested demand, simulated allocation, reserved or committed authorization, recorded consumption, and unknown provider usage; an authorization receipt is never presented as proof that work ran or credits were spent.

## Policy templates

The built-in library provides schema-only starting points for six resource classes. Selecting one imports typed fields, resource identity, ranking structure, and allocation strategy—not capacity, reserve, rules, requests, or assignments:

- disaster-resilience funding with all-or-nothing awards;
- MCP/agent credits with protected operational headroom and an allocation-bound, idempotent execution ledger;
- mobile-clinic hours using weighted fair sharing;
- emergency inventory with minimum viable partial deliveries;
- discrete school-inspection slots;
- rate-window API quotas with operational headroom.

Policies can use multiple resource pools. The user must define each pool's capacity and protected reserve. Pools also declare a unit, divisibility, and one of six allocation strategies: priority first-fit, priority with partial allocation, proportional share, weighted fair share, discrete slots, or rate-window quota.

The canvas presents every policy as one visible decision contract: **scope → eligibility → priority → limits → governance**. A guided five-step panel controls the program objective, boundary behavior, score range, primary resource envelope, allocation strategy, accountable owner, lifecycle dates, approval, and version-rationale requirements. Typed field/resource identities and ranking-schema replacement stay behind an explicitly labeled advanced editor. Automatic checks flag duplicate rules, conflicting outcome overrides, impossible numeric gates, retired or expired policies, and caps below requests' minimum useful amounts before a scenario can be applied.

## Starting a workspace

New guest and account workspaces open unconfigured. They do not claim a policy, capacity, reserve, rules, requests, assignments, versions, activity, or ledger history. A person can define a policy directly or explicitly choose a schema-only library starting point; either path requires the person to supply the policy values before simulation begins.

1. Open a new workspace or sign in for cloud persistence.
2. Define the policy's scope, resource capacity, reserve, and governance, optionally beginning from a schema-only library item.
3. Connect workers to **Request inbox** with scoped, revocable credentials, or use `submit_budget_requests` through browser WebMCP. Reusable HTTPS workers run independently of Codex. Manual scenario inputs remain available separately in **All requests**.
4. Compare incoming requests against the whole portfolio. Review and approve an exact budget grant, or use the policy's explicit automatic approval mode.
5. Compare a revision before applying it, then inspect its impact report and approval trail.
6. Optionally connect GitHub under **Connections**. Incoming requests with an execution binding can verify their source and prepare an exact-SHA action. The persistent **Assistant** button opens the built-in policy assistant from any page: read-only portfolio review by default, or explicit GitHub inspection and action preparation.

## Deterministic decision model

- Typed threshold rules determine eligibility; compound conditions support `AND` and `OR`.
- A request becomes a boundary case only when its failed numeric gates fit the policy's configurable failure-count and proximity tolerance.
- Score rules adjust a configurable base score inside a deterministic floor and ceiling; explicit outcome rules can route sensitive cases to review.
- Cap rules limit a matching request's demand from a named resource pool.
- The scenario lab previews capacity, reserve, allocation-strategy, and one-rule counterfactuals without mutating the active policy; applying one remains an explicit human action.
- Eligible requests are ordered by configurable score, field, and effective post-cap demand criteria with stable request ID as the final tie-breaker. Numeric fields use numeric order, booleans use false→true order, and enum fields use their configured option order rather than accidental alphabetical order.
- Sequential allocation strategies consume capacity in that published rank order.
- A policy cap can never silently lower a request's declared minimum useful amount. If effective demand falls below that minimum, the request receives zero with an explicit explanation.
- Share strategies distribute divisible capacity proportionally or by deterministic score weight, then remove and redistribute any share below its declared minimum useful amount.
- Every request exposes its rule trace, rank, per-resource allocation, status, and reason. Traces distinguish eligibility gates that passed or failed from score, outcome, and cap modifiers that were applied or simply did not apply.

## Execution ledger

Simulation answers what should happen. The ledger records what did happen:

```text
reserve → commit → consume → release
```

Every mutation carries a caller-supplied idempotency key. Exact retries do not double-reserve; reusing a key for a different request, resource, amount, actor, operation, or reconciliation is rejected instead of returning a misleading success. A reservation must reference a positive simulated allocation and cannot exceed either that request's remaining allocation or globally available capacity. Commits cannot exceed a request's reservation, consumption cannot exceed committed capacity, and reconciliation releases the unused remainder. Refund events can reverse recorded consumption without deleting history. New reservations require an active, effective policy with no blocking audit errors. A policy that retires after a reservation was made can still close that already-reserved execution without opening new capacity.

## Connected execution

RuleRipple closes one bounded connected-tool loop:

```text
GitHub pull request → declared intake → applicable-policy check → deterministic evaluation and resource allocation → human approval when required, otherwise policy authorization → exact GitHub action → receipt → authorization accounting
```

The first-party operator uses OpenAI `gpt-5.6-luna` for bounded tool coordination. It reads a pull request through the signed-in owner's GitHub OAuth connection, parses only the policy fields explicitly declared in one dedicated `## Policy intake` section, and calls RuleRipple's typed WebMCP-compatible tool contracts. Raw pull-request content is treated as untrusted data, and the model never calculates a policy result. Pull-request merges require GitHub to report an open, non-draft, mergeable pull request and use the exact inspected head SHA, repository, and PR number. A durable proposal pins the request, policy version, resource authorization, action, exact arguments, argument fingerprint, and source-intake fingerprint.

An active, effective policy with no blocking audit errors is mandatory. Denied, boundary, review, stale, expired, retired, unmatched, or unallocated requests cannot receive invocation authority. When governance requires approval, a person reviews the exact action and resource amount; **Approve & execute exact action** first persists the approval and reservation, then invokes GitHub and records the receipt. When approval is disabled, the same checks authorize only the exact eligible, allocated action and reserve its resource amount automatically under the pinned policy version.

The built-in executor re-reads GitHub immediately before mutation and rejects changed policy inputs, head SHA, declared intake, or a non-mergeable PR. Approval, reservation and a durable claim are saved atomically before the call. Uncertain results retain their reservation and permit read-only reconciliation, never another merge dispatch. Success commits authorization; it does not assert measured GitHub or AI usage.

**Request inbox** receives source-neutral budget requests and exposes funded, waiting and authorized decisions. GitHub-bound requests use **Verify evidence & prepare action** after intake. The adapter validates the received inputs and optional JSON budget mapping before preparing an action. The shared planner accounts for every request and existing commitment.

If an authorized action has not been invoked, it can be revoked from **External actions**; RuleRipple releases the reservation and retains the authorization and revocation evidence. Schema replacement is blocked once ledger or external-action evidence exists, preventing a reset from silently erasing execution history.

External WebMCP agents can still use `propose_external_execution`, `get_external_execution`, and `record_external_execution` with their own GitHub MCP connection. That interoperability path and the built-in path share the same domain checks and durable evidence model. This is policy-gated orchestration with configurable human approval and attributable execution evidence, not cryptographic enforcement over every GitHub or MCP client.

## WebMCP tools

| Tool | Effect | Purpose |
| --- | --- | --- |
| `get_policy_summary` | Read | Configuration state, bounded policy contract, automatic checks, rule counts, versions, and current simulation state |
| `create_policy` | Write + governed approval | Policy identity, boundary/scoring/governance settings, typed schema, and resources; fresh workspaces require complete explicit inputs and positive capacity |
| `add_rule` | Write + governed approval | Compound threshold, score, outcome, or resource-cap rule |
| `update_rule` | Write + governed approval | Revise a rule by stable ID |
| `remove_rule` | Write + confirmation | Stage removal for explicit human approval |
| `upsert_cases` | Write + governed approval | Add or update bounded requests by stable ID or name, with optional canonical GitHub provenance |
| `submit_budget_requests` | Receive + governed budget decision | Validate incoming agent envelopes, evaluate the whole portfolio, and await human approval or reserve under automatic policy |
| `get_request_inbox` | Read | Paginated incoming request status, proposed/authorized budget and source provenance |
| `evaluate_cases` | Read | Paginated outcomes, scores, traces, ranks, and compact resource allocations |
| `find_boundary_cases` | Read | Requests nearest failed or passed numeric thresholds, with the rule, field, operator, current value, and threshold value needed to explain or propose a revision |
| `save_policy_version` | Write | Immutable snapshot; rationale is enforced when the policy requires it |
| `compare_policy_versions` | Read | Full-snapshot outcome, rank, and allocation change counts with bounded affected-request details |
| `get_impact_reports` | Read | Paginate or inspect applied first-class policy-impact reports, including per-request resource deltas, by stable ID |
| `get_resource_ledger` | Read | Available, reserved, committed, consumed, and protected capacity |
| `reserve_resource` | Write + human approval | Stage an idempotent reservation within one request's simulated allocation |
| `reconcile_resource_usage` | Write + human approval | Stage commit, actual consumption, and release of the remainder |
| `propose_external_execution` | Write + governed authorization | Check policy applicability, eligibility, allocation, and remaining resource authorization; then persist or policy-authorize an exact allow-listed GitHub action |
| `get_external_execution` | Read | List executions after refresh, or inspect approval state, exact invocation arguments, ledger position, and any receipt |
| `record_external_execution` | Write | Record a real authorized GitHub MCP result and atomically reconcile optional provider-reported usage against that exact authorization |

The integration registers all 19 tools through the standard browser API and supplies an abort signal for lifecycle cleanup:

```ts
await document.modelContext.registerTool(tool, { signal: controller.signal });
```

Tool inputs use strict JSON schemas plus runtime validation: numeric strings are not coerced, oversized identities are rejected rather than truncated, external action arguments are allow-listed, and unconfigured request fields are rejected. A fresh workspace reports its required configuration through `get_policy_summary`; it will not accept rules, requests, or placeholder capacity, and `create_policy` requires explicit policy settings plus positive resource capacity before simulation can begin. Outputs are valid JSON and capped below 4,000 characters; portfolio evaluation is explicitly paginated rather than silently replaced with a preview. Tool registration is top-level-frame only. Incoming budget requests are received immediately; their budget authority waits for the configured checkpoint. Separately, when approval is enabled, agent-proposed policy, rule, and scenario-request mutations are staged: the active policy does not change until a person reviews the simulated outcome/allocation delta and approves it. Rule removal always remains pending until the person confirms it in the interface. Agent-proposed standalone resource reservations and usage reconciliations remain pending until a person approves the exact ledger events. External MCP proposals are durable across refreshes, and GitHub invocation authority remains false until either exact human approval or explicit policy authorization after all policy, eligibility, provenance, allocation, resource, version, and argument checks pass.

## Trust and durability

- Internal engine fixtures stay isolated from user workspaces and never appear as a user's allocation. RuleRipple is not an autonomous final-decision system.
- Human and agent actions use the same visible state and deterministic domain functions.
- Every applied simulation-input mutation creates an immutable policy version and a first-class impact report containing input changes, separate outcome/rank/allocation counts, affected requests, per-request and aggregate resource deltas, rationale, source actor, human approver when required, and version references. Reports are visible and exportable as JSON.
- Material mutations create timestamped, attributed activity entries and newest-first undo snapshots. Rollbacks create their own version and impact report instead of deleting prior evidence.
- Ledger and external-action evidence is append-only through RuleRipple's governed workflows. It is durable and attributable, but the current browser architecture does not claim cryptographic immutability or universal enforcement over other MCP clients.
- Firebase Authentication provides an individual-workspace identity boundary through same-origin server routes; the Firebase refresh token stays in a Secure, HttpOnly, SameSite cookie and is unavailable to browser JavaScript.
- Each signed-in user owns a Cloud Firestore manifest and bounded payload segments; Security Rules enforce the UID and authenticated email on manifests and the UID on every segment.
- A serialized save queue prevents an older delayed write from overwriting a newer edit.
- Atomic commit plus document update-time compare-and-set rejects stale cross-tab writes instead of silently overwriting confirmed state.
- Cloud loads fail closed: invalid or unavailable stored data is never silently replaced.
- Legacy device-local workspaces migrate once, after which Firestore is authoritative.
- External action proposals, approvals, and receipts persist inside the existing schema-v5 segmented payload, so the feature remains compatible with already-deployed ownership rules. The validated workspace payload remains split into sub-500 KB segments, avoiding the former single-document 1 MiB ceiling while preserving atomic manifest revision checks. Each workspace is intentionally bounded to 64 segments.
- The human simulator remains usable when WebMCP is not available in the browser.

## Develop and validate

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm dev
```

Use Node.js 22.13 or newer. Temporary local policy work does not require provider credentials. Cloud persistence and connected features require your own Firebase, OpenAI, and GitHub configuration as applicable; `.env.example` lists the settings without values. Keep actual credentials in an ignored `.env.local` file or your hosting service's secret store. The GitHub OAuth callback is `https://YOUR_HOST/api/github/callback`.

Keep `.openai/hosting.json` in a checkout: the build reads its non-secret resource-binding settings. This source snapshot contains no owner deployment IDs or credentials. Configure your own Sites project and Firebase project before deploying; local policy work does not require either project. See [SECURITY.md](./SECURITY.md) for the security boundary.

The automated suite covers configurable boundary and score behavior, policy-conflict checks, rank-order allocation, weighted fairness, partial inventory, discrete slots, legacy migration, segmented cloud persistence, impact-report validation, governance-aware versioning, version comparisons, serialized cloud saves, nested-data rejection, ledger capacity invariants, external-action allow lists, stale approvals, idempotent proposal and receipt retries, success/failure reconciliation, all 19 tools, response caps, security headers, Firestore rules, and representative direct/safety/multi-step agent journeys.

## Architecture

- React 19 + TypeScript
- Vinext/Vite, deployed as a Cloudflare-compatible OpenAI Site
- deterministic policy and ledger engine in `lib/domain.ts`
- reusable simulation library in `lib/presets.ts`
- WebMCP adapter and catalog in `lib/useWebMCP.ts` and `lib/webmcp-tools.ts`
- same-origin Firebase Authentication gateway and per-user segmented Cloud Firestore persistence
- first-party OpenAI operator with an owner-scoped, server-only GitHub OAuth connection, plus an external WebMCP interoperability path

## Scope boundary

RuleRipple is a transparent simulation and capacity-governance aid, not a legal-policy interpreter, payment processor, or autonomous grant/health/safety decision-maker. The browser engine is authoritative only for the declared inputs and its own recorded approval state. The connected GitHub result is attributable evidence, not proof that all external clients were forced through RuleRipple. The audit ledger is append-only through supported product workflows, not cryptographically immutable. Production use with real capacity requires verification, recovery, MFA or organizational identity, abuse controls, retention policies, signed approvals, and a server-side transactional enforcement service.

## License

RuleRipple is available under the [MIT License](./LICENSE).
