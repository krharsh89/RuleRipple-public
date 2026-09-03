import { agentFailure, authenticateAgent } from "../../../lib/agent-server";
import { FirebaseServerError, notificationRecords, privateJson, readFirebaseWorkspace, readJsonObject, saveNotificationRecord } from "../../../lib/firebase-server";
import { assertNotificationCurrent, authorizedNotification, NotificationError, notificationRepository } from "../../../lib/github-notifications";
import { GitHubIdentityError, verifyGitHubReceipt } from "../../../lib/github-oidc";

function failure(error: unknown) {
  if (error instanceof GitHubIdentityError) return privateJson({ error: `GITHUB_IDENTITY_${error.stage}` }, { status: 403 });
  if (error instanceof NotificationError) return privateJson({ error: "NOTIFICATION_BLOCKED", detail: error.message }, { status: error.status });
  return agentFailure(error);
}
async function currentNotification(request: Request, id: unknown) {
  const { session, connection, assertActive } = await authenticateAgent(request);
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new NotificationError("Invalid notification reference.", 400);
  const saved = (await notificationRecords(session, id))[0];
  // Both configured jobs wake; only the intended scoped worker can read/ack.
  if (!saved || saved.record.connectionId !== connection.id) throw new NotificationError("Notification not found for this worker.", 404);
  const stored = await readFirebaseWorkspace(session);
  if (!stored) throw new FirebaseServerError("WORKSPACE_NOT_FOUND", 404);
  const candidate = await authorizedNotification(stored.app.data, saved.record.requestId, connection, notificationRepository(process.env.GITHUB_NOTIFICATION_REPOSITORY));
  assertNotificationCurrent(saved.record, candidate);
  return { session, assertActive, saved, stored };
}
export async function GET(request: Request) {
  try {
    const { saved } = await currentNotification(request, new URL(request.url).searchParams.get("notification_id"));
    return privateJson({ notification: saved.record, audience: `${new URL(request.url).origin}/api/agent-notifications/${saved.record.id}`, executionPermitted: false });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const input = await readJsonObject(request, 18000);
    if (Object.keys(input).some((key) => !["notification_id", "github_identity"].includes(key)) || typeof input.github_identity !== "string") throw new NotificationError("A GitHub identity proof is required; amounts cannot be submitted.", 400);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { session, assertActive, saved, stored } = await currentNotification(request, input.notification_id);
      const receipt = await verifyGitHubReceipt(input.github_identity, `${new URL(request.url).origin}/api/agent-notifications/${saved.record.id}`, saved.record);
      if (saved.record.state === "acknowledged") return privateJson({ acknowledged: true, duplicate: true, receipt: saved.record.receipt, executionAttempted: false });
      await assertActive();
      try {
        await saveNotificationRecord(session, { ...saved.record, state: "acknowledged", receipt }, saved.updateTime, stored.updateTime);
        return privateJson({ acknowledged: true, duplicate: false, receipt, executionAttempted: false });
      } catch (error) { if (!(error instanceof FirebaseServerError) || error.code !== "NOTIFICATION_CONFLICT" || attempt === 2) throw error; }
    }
    throw new FirebaseServerError("NOTIFICATION_CONFLICT", 409);
  } catch (error) { return failure(error); }
}
