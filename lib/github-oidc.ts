import { CONFIRMATION_REF, CONFIRMATION_WORKFLOW, NotificationError, type BudgetNotification } from "./github-notifications.ts";

const ISSUER = "https://token.actions.githubusercontent.com";
type SigningKey = JsonWebKey & { kid?: string };
export class GitHubIdentityError extends NotificationError {
  readonly stage: string;
  constructor(stage: string) { super("GitHub workflow identity could not be verified. No receipt was recorded.", 403); this.stage = stage; }
}
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
export async function verifyGitHubReceipt(token: string, audience: string, record: BudgetNotification, fetchImpl: typeof fetch = fetch, now = Date.now()) {
  let stage = "TOKEN";
  try {
    if (typeof token !== "string" || token.length > 16000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const [head, body, signature] = token.split(".");
    const header = JSON.parse(new TextDecoder().decode(decode(head)));
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error();
    stage = "KEY_FETCH";
    // Workers supports manual/follow, not redirect:"error". Manual keeps this
    // on the fixed issuer: every redirect is rejected by the status check below.
    // Never follow jku/x5u or a caller-supplied URL.
    const response = await fetchImpl(`${ISSUER}/.well-known/jwks`, { headers: { accept: "application/json", "user-agent": "RuleRipple-Approval-Receipt" }, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    stage = `KEY_HTTP_${response.status}`;
    if (!response.ok) throw new Error();
    stage = "KEY_FORMAT";
    const jwks = await response.json() as { keys: SigningKey[] };
    if (!Array.isArray(jwks.keys)) throw new Error();
    stage = "KEY_MATCH";
    const jwk = jwks.keys.find((key) => key.kid === header.kid && key.kty === "RSA" && key.use === "sig");
    if (!jwk) throw new Error();
    stage = "SIGNATURE";
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(signature), new TextEncoder().encode(`${head}.${body}`))) throw new Error();
    const claims = JSON.parse(new TextDecoder().decode(decode(body)));
    const seconds = now / 1000;
    stage = "AUDIENCE";
    if (claims.iss !== ISSUER || claims.aud !== audience) throw new Error();
    stage = "TIME";
    if (!Number.isFinite(seconds) || !Number.isFinite(Date.parse(record.sentAt)) || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= seconds || typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > seconds + 30 || typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat > seconds + 30 || claims.iat < Date.parse(record.sentAt) / 1000 - 30) throw new Error();
    stage = "WORKFLOW";
    if (claims.repository?.toLowerCase() !== record.repository || claims.ref !== `refs/heads/${CONFIRMATION_REF}` || claims.event_name !== "workflow_dispatch" || claims.workflow_ref?.toLowerCase() !== `${record.repository}/.github/workflows/${CONFIRMATION_WORKFLOW}@refs/heads/${CONFIRMATION_REF}`) throw new Error();
    stage = "RUN";
    if (typeof claims.run_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(claims.run_id) || typeof claims.run_attempt !== "string" || !/^[1-9][0-9]{0,5}$/.test(claims.run_attempt)) throw new Error();
    return { runId: claims.run_id as string, runAttempt: claims.run_attempt as string, url: `https://github.com/${record.repository}/actions/runs/${claims.run_id}`, at: new Date(now).toISOString() };
  } catch { throw new GitHubIdentityError(stage); }
}
