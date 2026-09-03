import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Reusable transport worker: no model, provider credentials, or execution step.
// Call from an agent runtime or CI job after that runtime creates real requests.
export async function deliverRequests({ origin, credential, requests, fetchImpl = fetch, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("RULERIPPLE_ORIGIN must be an HTTPS origin without credentials, path or query.");
  if (typeof credential !== "string" || !/^rragent1\.[a-zA-Z0-9_-]+$/.test(credential)) throw new Error("Configure a scoped RULERIPPLE_AGENT_CREDENTIAL secret.");
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 25) throw new Error("Request file must contain one to 25 actual requests.");
  if (requests.some((r) => !r || typeof r !== "object" || !r.submission_id || "agent" in r)) throw new Error("Each request needs a stable submission_id; agent identity comes from the connection.");
  const body = JSON.stringify({ requests });
  if (Buffer.byteLength(body) > 100000) throw new Error("Request delivery exceeds 100KB.");
  const endpoint = `${url.origin}/api/agent-requests`;
  async function call(method, suffix = "") {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetchImpl(endpoint + suffix, { method, headers: { authorization: `Bearer ${credential}`, accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) }, ...(method === "POST" ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(30000) });
      } catch {
        if (attempt === 2) throw new Error("RuleRipple could not be reached. Retry the same file; never change its submission IDs to retry.");
        await pause(500 * 2 ** attempt); continue;
      }
      if ([409, 429, 502, 503, 504].includes(response.status) && attempt < 2) { await pause(500 * 2 ** attempt); continue; }
      // Never print arbitrary response bodies: they may echo supplied data.
      if (!response.ok) throw new Error(`RuleRipple returned HTTP ${response.status}. Check the connection, scope and request schema. No execution was attempted.`);
      try { return await response.json(); } catch { throw new Error("RuleRipple returned an invalid response; retry the same request file."); }
    }
  }
  const delivery = await call("POST");
  if (!Array.isArray(delivery.received) || !Array.isArray(delivery.duplicates)) throw new Error("Invalid delivery receipt.");
  const ids = [...new Set([...delivery.received, ...delivery.duplicates])];
  const rows = [];
  for (const id of ids) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw new Error("Invalid request receipt ID.");
    const decision = await call("GET", `?request_id=${encodeURIComponent(id)}`);
    if (!Array.isArray(decision.rows) || decision.rows.length !== 1 || decision.rows[0].requestId !== id) throw new Error("Could not verify this worker's recorded decision.");
    const row = decision.rows[0];
    rows.push({ requestId: id, status: row.status, requested: row.requested, proposed: row.proposed, authorized: row.authorized, remainingAuthorization: row.accounting?.remainingAuthorization, recordedConsumption: row.accounting?.consumed });
  }
  return { received: delivery.received.length, duplicateRetries: delivery.duplicates.length, decisions: rows, executionAttempted: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const path = process.argv[2];
    if (!path) throw new Error("Usage: node agent-worker.mjs path/to/request.json");
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (!raw || Object.keys(raw).some((key) => key !== "requests")) throw new Error("Request file must contain only the requests array.");
    const result = await deliverRequests({ origin: process.env.RULERIPPLE_ORIGIN, credential: process.env.RULERIPPLE_AGENT_CREDENTIAL, requests: raw.requests });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.stdout.write("Delivery complete. Proposed allocation is not authorization. Recorded consumption is not provider-metered usage. This worker never executes external actions.\n");
  } catch (error) {
    // Never log environment, request payloads, credentials, or arbitrary errors.
    const known = error instanceof Error && /^(RULERIPPLE_ORIGIN|Configure a scoped|Request file|Each request|Request delivery|RuleRipple |Invalid delivery|Invalid request|Could not verify|Usage:)/.test(error.message);
    process.stderr.write((known ? error.message : "Worker failed. Check its configuration and request file; no external execution was attempted.") + "\n");
    process.exitCode = 1;
  }
}
