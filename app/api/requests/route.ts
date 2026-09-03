import { authenticatedIntakeSession, FirebaseServerError, privateJson, readFirebaseWorkspace, readJsonObject, setSessionCookie, writeFirebaseWorkspace } from "../../../lib/firebase-server";
import { InboxError, receiveAgentRequests, requestInboxView } from "../../../lib/request-inbox";
import { BatchError } from "../../../lib/operator-batch";

function failure(error: unknown) {
  if (error instanceof InboxError || error instanceof BatchError) return privateJson({ error: "INVALID_INCOMING_REQUEST", detail: error.message }, { status: 422 });
  const known = error instanceof FirebaseServerError ? error : new FirebaseServerError("REQUEST_INTAKE_FAILED", 502);
  return privateJson({ error: known.code }, { status: known.status });
}
export async function GET(request: Request) {
  try {
    const { session, bearer } = await authenticatedIntakeSession(request);
    const stored = await readFirebaseWorkspace(session);
    if (!stored) throw new FirebaseServerError("WORKSPACE_NOT_FOUND", 404);
    const view = await requestInboxView(stored.app.data);
    const id = new URL(request.url).searchParams.get("request_id");
    const response = privateJson({ ...view, rows: id ? view.rows.filter((row) => row.requestId === id) : view.rows, intake: { fields: stored.app.data.policy.fields, resources: stored.app.data.policy.resources.map(({ id, label, unit }) => ({ id, label, unit })) }, ...(!bearer ? { app: stored.app } : {}) });
    if (!bearer) setSessionCookie(response, session.refreshToken);
    return response;
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const { session, bearer } = await authenticatedIntakeSession(request);
    const input = await readJsonObject(request, 100_000);
    if (Object.keys(input).some((key) => key !== "requests")) throw new InboxError("Only incoming requests may be submitted to this endpoint.");
    // A concurrent delivery retries against the latest portfolio, never an old
    // allocation. The atomic workspace precondition prevents double spending.
    for (let attempt = 0; attempt < 3; attempt++) {
      const stored = await readFirebaseWorkspace(session);
      if (!stored) throw new FirebaseServerError("WORKSPACE_NOT_FOUND", 404);
      const result = await receiveAgentRequests(stored.app, input.requests);
      try {
        const saved = await writeFirebaseWorkspace(session, result.app, JSON.stringify(stored.app));
        const view = await requestInboxView(saved.app.data);
        const response = privateJson({ received: result.received, duplicates: result.duplicates, ...view, ...(!bearer ? { app: saved.app } : {}) }, { status: result.received.length ? 201 : 200 });
        if (!bearer) setSessionCookie(response, session.refreshToken);
        return response;
      } catch (error) { if (!(error instanceof FirebaseServerError) || error.code !== "CLOUD_CONFLICT" || attempt === 2) throw error; }
    }
    throw new FirebaseServerError("CLOUD_CONFLICT", 409);
  } catch (error) { return failure(error); }
}
