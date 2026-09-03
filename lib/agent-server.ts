import "server-only";
import { AgentConnectionError, assertActiveConnection, openAgentCredential } from "./agent-connections";
import { agentConnectionRecords, authenticatedFirebaseSession, assertSameOrigin, FirebaseServerError, privateJson, refreshFirebaseSession } from "./firebase-server";
import { InboxError } from "./request-inbox";
import { BatchError } from "./operator-batch";

export function agentCredentialSecret() { return process.env.AGENT_CREDENTIAL_KEY ?? ""; }
export function agentConnectionsConfigured() { return /^[a-f0-9]{64}$/i.test(agentCredentialSecret()); }
export async function agentOwnerSession(request: Request) {
  if (request.headers.has("authorization")) throw new AgentConnectionError("Sign in as the workspace owner to manage connections.", 403);
  if (request.method !== "GET") assertSameOrigin(request);
  return authenticatedFirebaseSession(request);
}
export async function authenticateAgent(request: Request) {
  const match = /^Bearer (rragent1\.[a-zA-Z0-9_-]+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new AgentConnectionError("A scoped agent credential is required.", 401);
  const token = match[1];
  const capability = await openAgentCredential(token, new URL(request.url).origin, agentCredentialSecret());
  const session = await refreshFirebaseSession(capability.refreshToken);
  if (session.user.uid !== capability.ownerId) throw new AgentConnectionError("Agent owner session is no longer valid.", 401);
  const assertActive = async () => assertActiveConnection(capability.connection, (await agentConnectionRecords(session, capability.connection.id))[0] ?? null, token);
  await assertActive();
  return { session, connection: capability.connection, assertActive };
}
export function agentFailure(error: unknown) {
  if (error instanceof AgentConnectionError) return privateJson({ error: "AGENT_CONNECTION_ERROR", detail: error.message }, { status: error.status });
  if (error instanceof InboxError || error instanceof BatchError) return privateJson({ error: "INVALID_AGENT_REQUEST", detail: error.message }, { status: 422 });
  const known = error instanceof FirebaseServerError ? error : new FirebaseServerError("AGENT_REQUEST_FAILED", 502);
  return privateJson({ error: known.code }, { status: known.status });
}
