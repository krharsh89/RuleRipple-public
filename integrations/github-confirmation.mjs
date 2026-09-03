import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// A receipt-only worker. It never spends, changes policy, approves, or merges.
export async function confirmAuthorization({ origin, credential, notificationId, getIdentity, fetchImpl = fetch, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const site = new URL(origin);
  if (site.protocol !== "https:" || site.username || site.password || site.pathname !== "/" || site.search || site.hash || !/^rragent1\.[A-Za-z0-9_-]+$/.test(credential ?? "") || !/^[a-f0-9]{64}$/.test(notificationId ?? "")) throw new Error("Invalid confirmation configuration.");
  const endpoint = `${site.origin}/api/agent-notifications`;
  async function call(method, body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try { response = await fetchImpl(method === "GET" ? `${endpoint}?notification_id=${notificationId}` : endpoint, { method, headers: { authorization: `Bearer ${credential}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(30_000) }); }
      catch { if (attempt < 2) { await pause(1000 * (attempt + 1)); continue; } throw new Error("RuleRipple confirmation could not be reached."); }
      if (method === "GET" && response.status === 404) return null;
      if ([409, 429, 502, 503, 504].includes(response.status) && attempt < 2) { await pause(1000 * (attempt + 1)); continue; }
      if (!response.ok) {
        const value = await response.json().catch(() => null);
        const code = typeof value?.error === "string" && /^GITHUB_IDENTITY_(TOKEN|KEYS|KEY_FETCH|KEY_FORMAT|KEY_MATCH|KEY_HTTP_[1-5][0-9]{2}|SIGNATURE|AUDIENCE|TIME|WORKFLOW|RUN)$/.test(value.error) ? ` ${value.error}` : "";
        throw new Error(`RuleRipple confirmation rejected (${response.status}, ${method}).${code}`);
      }
      return response.json();
    }
  }
  const current = await call("GET");
  if (!current) return { skipped: true, message: "This notification belongs to the other worker.", executionAttempted: false };
  const n = current.notification;
  const audience = `${site.origin}/api/agent-notifications/${notificationId}`;
  if (!n || n.id !== notificationId || !/^[A-Za-z0-9_-]{1,40}$/.test(n.requestId) || !Number.isFinite(n.remaining) || n.remaining <= 0 || !Number.isFinite(n.authorized) || n.authorized < n.remaining || current.audience !== audience || current.executionPermitted !== false) throw new Error("Invalid authorization confirmation.");
  // No amount or decision is taken from workflow inputs. The server rechecks
  // the ledger again when recording this GitHub-signed acknowledgement.
  const identity = await getIdentity(audience);
  const result = await call("POST", { notification_id: notificationId, github_identity: identity });
  if (!result?.acknowledged || result.executionAttempted !== false) throw new Error("RuleRipple did not confirm receipt.");
  return { skipped: false, requestId: n.requestId, authorized: n.authorized, remainingAuthorization: n.remaining, acknowledged: true, duplicate: result.duplicate === true, executionAttempted: false, measuredUsage: "not reported" };
}

export async function githubIdentity(audience) {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "");
  // The runner supplies this URL; never use a workflow input as a token host.
  if (url.protocol !== "https:" || !url.hostname.endsWith(".actions.githubusercontent.com") || url.username || url.password) throw new Error("GitHub identity endpoint unavailable.");
  url.searchParams.set("audience", audience);
  const response = await fetch(url, { headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("GitHub identity proof unavailable.");
  const value = await response.json();
  if (typeof value.value !== "string") throw new Error("GitHub identity proof missing.");
  return value.value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await confirmAuthorization({ origin: process.env.RULERIPPLE_ORIGIN, credential: process.env.RULERIPPLE_AGENT_CREDENTIAL, notificationId: process.env.RULERIPPLE_NOTIFICATION_ID, getIdentity: githubIdentity });
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, result.skipped ? "Notification is for the other scoped worker. No action taken.\n" : `### RuleRipple authorization received\n\nRequest: \`${result.requestId}\`\n\nOriginal authorization: **${result.authorized}**. Remaining authorization at confirmation: **${result.remainingAuthorization}**.\n\nReceipt saved in RuleRipple. No workload executed, no provider quota changed, and no measured usage reported.\n`);
  } catch (error) { console.error(error instanceof Error ? error.message : "Confirmation failed."); process.exitCode = 1; }
}
