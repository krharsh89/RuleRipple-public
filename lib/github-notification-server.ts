import "server-only";
import { agentConnectionRecords, FirebaseServerError, notificationRecords, privateJson, readFirebaseWorkspace, saveNotificationRecord, type FirebaseSession } from "./firebase-server";
import { dispatchBudgetConfirmation, githubAccessToken, GitHubServerError, requireOperatorAccess } from "./github-server";
import { authorizedNotification, nextNotification, notificationRepository, NotificationError } from "./github-notifications";

export async function sendBudgetNotification(request: Request, session: FirebaseSession, requestId: string) {
  requireOperatorAccess(session.user.email);
  const repository = notificationRepository(process.env.GITHUB_NOTIFICATION_REPOSITORY);
  const token = githubAccessToken(request, session.user.uid);
  if (!token) throw new NotificationError("Connect GitHub before sending the approval notification.", 401);
  const stored = await readFirebaseWorkspace(session);
  if (!stored) throw new FirebaseServerError("WORKSPACE_NOT_FOUND", 404);
  const entry = stored.app.data.inbox?.find((item) => item.requestId === requestId);
  const connection = entry && (await agentConnectionRecords(session)).find((c) => c.id === entry.agent.id);
  if (!connection) throw new NotificationError("This request needs an active, scoped GitHub worker connection.");
  const candidate = await authorizedNotification(stored.app.data, requestId, connection, repository);
  const prior = (await notificationRecords(session, candidate.id))[0] ?? null;
  const record = nextNotification(candidate, prior?.record ?? null);
  if (record.state === "acknowledged") return record;
  await saveNotificationRecord(session, record, prior?.updateTime ?? null, stored.updateTime);
  let state: "sent" | "uncertain" | "failed" = "sent";
  try { await dispatchBudgetConfirmation(token, repository, record.id); }
  catch (error) { state = error instanceof GitHubServerError && error.status < 500 ? "failed" : "uncertain"; }
  const latest = (await notificationRecords(session, record.id))[0];
  // A fast GitHub callback wins over the dispatch response. Never overwrite it.
  if (latest?.record.state === "acknowledged") return latest.record;
  if (latest && latest.record.attempt === record.attempt) {
    try { await saveNotificationRecord(session, { ...record, state }, latest.updateTime); }
    catch (error) { if (!(error instanceof FirebaseServerError) || error.code !== "NOTIFICATION_CONFLICT") throw error; }
  }
  return (await notificationRecords(session, record.id))[0]?.record ?? { ...record, state };
}
export function notificationFailure(error: unknown) {
  if (error instanceof NotificationError) return privateJson({ error: "GITHUB_NOTIFICATION_BLOCKED", detail: error.message }, { status: error.status });
  const known = error instanceof FirebaseServerError || error instanceof GitHubServerError ? error : new FirebaseServerError("GITHUB_NOTIFICATION_FAILED", 502);
  return privateJson({ error: known.code }, { status: known.status });
}
