import { agentConnectionRecords, createAgentConnectionRecord, privateJson, readFirebaseWorkspace, readJsonObject, revokeAgentConnectionRecord, setSessionCookie } from "../../../lib/firebase-server";
import { AgentConnectionError, issueAgentCredential, newAgentConnection } from "../../../lib/agent-connections";
import { agentConnectionsConfigured, agentCredentialSecret, agentFailure, agentOwnerSession } from "../../../lib/agent-server";

export async function GET(request: Request) {
  try {
    const session = await agentOwnerSession(request);
    const configured = agentConnectionsConfigured();
    const records = configured ? await agentConnectionRecords(session) : [];
    const response = privateJson({ configured, connections: records.map((record) => { const { tokenHash, ...connection } = record; void tokenHash; return connection; }) });
    setSessionCookie(response, session.refreshToken);
    return response;
  } catch (error) { return agentFailure(error); }
}
export async function POST(request: Request) {
  try {
    const session = await agentOwnerSession(request);
    if (!agentConnectionsConfigured()) throw new AgentConnectionError("The host must configure its server-side agent credential key.", 503);
    const stored = await readFirebaseWorkspace(session);
    if (!stored) throw new AgentConnectionError("Save a configured workspace before connecting an agent.");
    const input = await readJsonObject(request, 4096);
    const existing = await agentConnectionRecords(session);
    if (existing.filter((r) => Date.parse(r.expiresAt) > Date.now()).length >= 25) throw new AgentConnectionError("Revoke an unused connection before creating another (25 active connections maximum).");
    const connection = newAgentConnection(input, stored.app.data);
    const { token, record } = await issueAgentCredential(connection, session.user.uid, session.refreshToken, new URL(request.url).origin, agentCredentialSecret());
    await createAgentConnectionRecord(session, record);
    const response = privateJson({ connection, credential: token }, { status: 201 });
    setSessionCookie(response, session.refreshToken);
    return response;
  } catch (error) { return agentFailure(error); }
}
export async function DELETE(request: Request) {
  try {
    const session = await agentOwnerSession(request);
    const input = await readJsonObject(request, 512);
    if (Object.keys(input).length !== 1 || typeof input.id !== "string") throw new AgentConnectionError("Specify only the connection ID to revoke.");
    await revokeAgentConnectionRecord(session, input.id);
    const response = privateJson({ revoked: true });
    setSessionCookie(response, session.refreshToken);
    return response;
  } catch (error) { return agentFailure(error); }
}
