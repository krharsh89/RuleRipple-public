import { FirebaseServerError, privateJson, readFirebaseWorkspace, readJsonObject, writeFirebaseWorkspace } from "../../../lib/firebase-server";
import { AgentConnectionError, ownAgentDecisions, scopeAgentRequests } from "../../../lib/agent-connections";
import { agentFailure, authenticateAgent } from "../../../lib/agent-server";
import { receiveAgentRequests, requestInboxView } from "../../../lib/request-inbox";

export async function GET(request: Request) {
  try {
    const { session, connection } = await authenticateAgent(request);
    const stored = await readFirebaseWorkspace(session);
    if (!stored) throw new FirebaseServerError("WORKSPACE_NOT_FOUND", 404);
    const view = await requestInboxView(stored.app.data);
    const resource = stored.app.data.policy.resources.find((r) => r.id === connection.resourceId);
    return privateJson({ ...ownAgentDecisions(view, connection, new URL(request.url).searchParams.get("request_id")), connection: { id: connection.id, name: connection.name, system: connection.system, resourceId: connection.resourceId, maxRequested: connection.maxRequested, expiresAt: connection.expiresAt }, intake: { fields: stored.app.data.policy.fields, resource: resource ? { id: resource.id, label: resource.label, unit: resource.unit } : null } });
  } catch (error) { return agentFailure(error); }
}
export async function POST(request: Request) {
  try {
    const { session, connection, assertActive } = await authenticateAgent(request);
    const input = await readJsonObject(request, 100_000);
    if (Object.keys(input).some((k) => k !== "requests")) throw new AgentConnectionError("Only requests may be submitted. Approval is controlled by policy.");
    for (let attempt = 0; attempt < 3; attempt++) {
      const stored = await readFirebaseWorkspace(session);
      if (!stored) throw new FirebaseServerError("WORKSPACE_NOT_FOUND", 404);
      const scoped = scopeAgentRequests(input.requests, connection, stored.app.data);
      const result = await receiveAgentRequests(stored.app, scoped);
      try {
        await assertActive();
        const saved = await writeFirebaseWorkspace(session, result.app, JSON.stringify(stored.app));
        const view = ownAgentDecisions(await requestInboxView(saved.app.data), connection);
        return privateJson({ received: result.received, duplicates: result.duplicates, ...view }, { status: result.received.length ? 201 : 200 });
      } catch (error) { if (!(error instanceof FirebaseServerError) || error.code !== "CLOUD_CONFLICT" || attempt === 2) throw error; }
    }
    throw new FirebaseServerError("CLOUD_CONFLICT", 409);
  } catch (error) { return agentFailure(error); }
}
