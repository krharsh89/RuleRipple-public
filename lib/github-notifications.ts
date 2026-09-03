// Authorization snapshots and receipts, not workload execution or usage.
import type { WorkspaceData } from "./domain.ts";
import type { AgentConnection } from "./agent-connections.ts";
import { inboxFingerprint, requestInboxView } from "./request-inbox.ts";

export const CONFIRMATION_WORKFLOW = "ruleripple-confirmation.yml";
export const CONFIRMATION_REF = "main";
export class NotificationError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}
export interface BudgetNotification {
  id: string;
  requestId: string;
  connectionId: string;
  repository: string;
  authorizationFingerprint: string;
  authorized: number;
  remaining: number;
  unit: string;
  policyVersion: string;
  state: "dispatching" | "sent" | "uncertain" | "failed" | "acknowledged";
  sentAt: string;
  expiresAt: string;
  attempt: number;
  receipt?: { runId: string; runAttempt: string; url: string; at: string };
}
export function notificationRepository(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value)) throw new NotificationError("GitHub notifications have not been configured by the host.", 503);
  return value.toLowerCase();
}
export async function authorizedNotification(data: WorkspaceData, requestId: string, connection: AgentConnection, repository: string, now = Date.now()): Promise<BudgetNotification> {
  const entry = data.inbox?.find((item) => item.requestId === requestId);
  const view = await requestInboxView(data), row = view.rows.find((item) => item.requestId === requestId);
  if (!entry || entry.agent.id !== connection.id || connection.system !== "github" || entry.source.system !== "github" || entry.resourceId !== connection.resourceId) throw new NotificationError("This request does not belong to an active GitHub worker.", 403);
  if (connection.revokedAt || !Number.isFinite(Date.parse(connection.expiresAt)) || Date.parse(connection.expiresAt) <= now) throw new NotificationError("The worker connection has expired or was revoked.", 403);
  if (entry.execution || entry.decision?.status !== "approved" || !row || row.settled || row.accounting.remainingAuthorization <= 0 || view.blockers.length) throw new NotificationError("A current, unspent budget authorization is required. No approval was created.");
  const authorizationFingerprint = await inboxFingerprint({ requestId, decision: entry.decision, accounting: row.accounting });
  const target = notificationRepository(repository);
  const id = (await inboxFingerprint({ connection: connection.id, requestId, authorizationFingerprint, repository: target })).slice(7);
  return { id, requestId, connectionId: connection.id, repository: target, authorizationFingerprint, authorized: entry.decision.amount, remaining: row.accounting.remainingAuthorization, unit: row.unit, policyVersion: entry.decision.policyVersionId, state: "dispatching", sentAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 60_000).toISOString(), attempt: 1 };
}
export function nextNotification(candidate: BudgetNotification, previous: BudgetNotification | null, now = Date.now()) {
  if (!previous) return candidate;
  if (previous.id !== candidate.id) throw new NotificationError("Notification identity changed.");
  if (previous.state === "acknowledged") return previous;
  // Never automatically retry an ambiguous dispatch. Explicit retry after a
  // cooling period is safe: workers only acknowledge the same authorization.
  if (now - Date.parse(previous.sentAt) < 60_000) throw new NotificationError("GitHub confirmation is pending. Wait one minute before retrying.", 429);
  return { ...candidate, attempt: previous.attempt + 1 };
}
export function assertNotificationCurrent(record: BudgetNotification, candidate: BudgetNotification, now = Date.now()) {
  if (record.id !== candidate.id || record.authorizationFingerprint !== candidate.authorizationFingerprint || record.connectionId !== candidate.connectionId || record.remaining !== candidate.remaining) throw new NotificationError("The authorization changed. Refresh the request before notifying GitHub again.");
  if (!Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= now) throw new NotificationError("This notification expired. The owner can send a fresh confirmation.");
}
