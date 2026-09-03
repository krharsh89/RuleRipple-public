// Pure capability and scope logic. Secrets are supplied only by the server.
import { resourceRequiresWholeUnits, type WorkspaceData } from "./domain.ts";
import { canonicalJson } from "./operator-intake.ts";
import { inboxFingerprint, parseAgentRequest, type AgentRequestInput, type InboxView } from "./request-inbox.ts";

export class AgentConnectionError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}
export interface AgentConnection {
  id: string;
  name: string;
  system: string;
  resourceId: string;
  maxRequested: number;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
export interface StoredAgentConnection extends AgentConnection { tokenHash: string }
interface Capability { version: 1; ownerId: string; connection: AgentConnection; refreshToken: string; audience: string }
const encoder = new TextEncoder();
const prefix = "rragent1.";
const aad = encoder.encode("RuleRipple agent intake capability v1");
function bytesToText(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function textToBytes(text: string) { return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=")), (c) => c.charCodeAt(0)); }
async function encryptionKey(secret: string) {
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new AgentConnectionError("Agent connections are not configured on this host.", 503);
  return crypto.subtle.importKey("raw", Uint8Array.from(secret.match(/../g)!, (v) => parseInt(v, 16)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export function newAgentConnection(raw: Record<string, unknown>, data: WorkspaceData, now = Date.now()): AgentConnection {
  if (Object.keys(raw).some((key) => !["name", "system", "resourceId", "maxRequested", "days"].includes(key))) throw new AgentConnectionError("Unknown connection setting.");
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 80) throw new AgentConnectionError("Enter an agent name (up to 80 characters).");
  if (typeof raw.system !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(raw.system)) throw new AgentConnectionError("Enter a source identifier using lowercase letters, numbers, hyphens or underscores.");
  const resource = data.policy.resources.find((r) => r.id === raw.resourceId);
  if (!resource || resource.capacity <= 0) throw new AgentConnectionError("Choose a configured resource with positive capacity.");
  if (typeof raw.maxRequested !== "number" || !Number.isFinite(raw.maxRequested) || raw.maxRequested <= 0 || raw.maxRequested > resource.capacity || (resourceRequiresWholeUnits(resource) && !Number.isInteger(raw.maxRequested))) throw new AgentConnectionError("Set a positive per-request limit within the resource capacity and units.");
  if (![1, 7, 30].includes(Number(raw.days)) || typeof raw.days !== "number") throw new AgentConnectionError("Choose a 1, 7 or 30 day connection.");
  return { id: crypto.randomUUID(), name: raw.name.trim(), system: raw.system, resourceId: resource.id, maxRequested: raw.maxRequested, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + raw.days * 86400000).toISOString(), revokedAt: null };
}
export async function issueAgentCredential(connection: AgentConnection, ownerId: string, refreshToken: string, audience: string, secret: string) {
  if (!ownerId || !refreshToken || !audience) throw new AgentConnectionError("A current owner session is required.", 401);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload: Capability = { version: 1, ownerId, connection, refreshToken, audience };
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, await encryptionKey(secret), encoder.encode(JSON.stringify(payload)));
  const token = prefix + bytesToText(new Uint8Array([...iv, ...new Uint8Array(encrypted)]));
  return { token, record: { ...connection, tokenHash: await inboxFingerprint(token) } };
}
export async function openAgentCredential(token: string, audience: string, secret: string, now = Date.now()): Promise<Capability> {
  const key = await encryptionKey(secret);
  try {
    if (!token.startsWith(prefix) || token.length > 12000 || !/^[a-zA-Z0-9_-]+$/.test(token.slice(prefix.length))) throw new Error();
    const bytes = textToBytes(token.slice(prefix.length));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad }, key, bytes.slice(12));
    const value = JSON.parse(new TextDecoder().decode(plaintext)) as Capability;
    const c = value.connection;
    if (value.version !== 1 || value.audience !== audience || !value.ownerId || !value.refreshToken || !c || !/^[a-f0-9-]{36}$/.test(c.id) || c.revokedAt || !Number.isFinite(Date.parse(c.expiresAt)) || Date.parse(c.expiresAt) <= now || Date.parse(c.createdAt) > now || Date.parse(c.expiresAt) - Date.parse(c.createdAt) > 30 * 86400000) throw new Error();
    return value;
  } catch { throw new AgentConnectionError("Agent credential is invalid or expired. Create a new connection in RuleRipple.", 401); }
}
export async function assertActiveConnection(expected: AgentConnection, stored: StoredAgentConnection | null, token: string, now = Date.now()) {
  if (!stored || stored.revokedAt || Date.parse(stored.expiresAt) <= now || stored.tokenHash !== await inboxFingerprint(token)) throw new AgentConnectionError("Agent connection has been revoked or changed.", 401);
  const { tokenHash, ...metadata } = stored; void tokenHash;
  if (canonicalJson(metadata) !== canonicalJson(expected)) throw new AgentConnectionError("Agent connection scope changed.", 401);
}
export function scopeAgentRequests(raw: unknown, connection: AgentConnection, data: WorkspaceData): AgentRequestInput[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 25) throw new AgentConnectionError("Submit between one and 25 requests.");
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentConnectionError("Expected a request object.");
    const item = value as Record<string, unknown>;
    if ("agent" in item) throw new AgentConnectionError("Agent identity comes from the connection; omit the agent field.");
    if (typeof item.submission_id !== "string" || !item.submission_id.trim() || item.submission_id.length > 100) throw new AgentConnectionError("Supply a retry-safe submission ID of up to 100 characters.");
    const request = parseAgentRequest({ ...item, submission_id: `${connection.id}:${item.submission_id}`, agent: { id: connection.id, name: connection.name } }, data);
    if (request.resource_id !== connection.resourceId || request.source.system !== connection.system || request.requested > connection.maxRequested) throw new AgentConnectionError("Request exceeds this connection's resource, source or per-request scope.", 403);
    return request;
  });
}
export function ownAgentDecisions(view: InboxView, connection: AgentConnection, requestId?: string | null) {
  // Never return workspace state, other workers, review fingerprints, or global
  // blockers (which can include another request's validation details).
  return { approvalRequired: view.approvalRequired, rows: view.rows.filter((r) => r.agent.id === connection.id && r.resourceId === connection.resourceId && (!requestId || r.requestId === requestId)).map((r) => ({ requestId: r.requestId, name: r.name, status: r.status, requested: r.requested, minimum: r.minimum, proposed: r.proposed, authorized: r.authorized, accounting: r.accounting, settled: r.settled, unit: r.unit, outcome: r.outcome, rank: r.rank, executionId: r.executionId, explanation: "Decisions use the entire active portfolio. Proposed amounts are not authorization; authorization is not measured usage." })) };
}
