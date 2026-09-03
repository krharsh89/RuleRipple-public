import { assertSameOrigin, authenticatedFirebaseSession, FirebaseServerError, privateJson, readFirebaseWorkspace, readJsonObject, setSessionCookie, writeFirebaseWorkspace } from "../../../../lib/firebase-server";
import { decideInboxRequest, InboxError, requestInboxView } from "../../../../lib/request-inbox";
import { sendBudgetNotification } from "../../../../lib/github-notification-server";

export async function POST(request: Request) {
  try {
    // Human decisions are intentionally not a bearer-token intake capability.
    if (request.headers.has("authorization")) throw new FirebaseServerError("HUMAN_SESSION_REQUIRED", 403);
    assertSameOrigin(request);
    const session = await authenticatedFirebaseSession(request);
    const input = await readJsonObject(request, 2_048);
    const stored = await readFirebaseWorkspace(session);
    if (!stored) throw new FirebaseServerError("WORKSPACE_NOT_FOUND", 404);
    const app = await decideInboxRequest(stored.app, input, "Workspace owner");
    const saved = await writeFirebaseWorkspace(session, app, JSON.stringify(stored.app));
    // Notification failure never rolls back an already-saved budget decision
    // or turns a successful approval into an apparent failure/retry.
    let notification = null;
    let notificationPending = false;
    const entry = saved.app.data.inbox?.find((item) => item.requestId === input.request_id);
    if (input.decision === "approve" && entry?.source.system === "github" && process.env.GITHUB_NOTIFICATION_REPOSITORY) {
      try { notification = await sendBudgetNotification(request, session, entry.requestId); }
      catch { notificationPending = true; }
    }
    const response = privateJson({ app: saved.app, ...await requestInboxView(saved.app.data), notification, notificationPending });
    setSessionCookie(response, session.refreshToken);
    return response;
  } catch (error) {
    if (error instanceof InboxError) return privateJson({ error: "INBOX_DECISION_BLOCKED", detail: error.message }, { status: 409 });
    const known = error instanceof FirebaseServerError ? error : new FirebaseServerError("INBOX_DECISION_FAILED", 502);
    return privateJson({ error: known.code }, { status: known.status });
  }
}
