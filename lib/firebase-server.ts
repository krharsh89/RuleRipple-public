import "server-only";
import { assertClientOperatorState, ExecutionError } from "./operator-execution-core";
import { assertInboxUnchanged, InboxError } from "./request-inbox";
import type { StoredAgentConnection } from "./agent-connections";

import { NextResponse } from "next/server";
import {
  CLOUD_SCHEMA_VERSION,
  cloudWriteDecision,
  restoreSegmentedAppState,
  safeAppState,
  safeCloudWorkspaceDocument,
  safeCloudWorkspaceManifest,
  segmentAppState,
  type AppState,
} from "./cloud-state";

export interface AuthenticatedUser {
  uid: string;
  email: string;
}

export interface FirebaseSession {
  user: AuthenticatedUser;
  idToken: string;
  refreshToken: string;
}

export class FirebaseServerError extends Error {
  constructor(public readonly code: string, public readonly status = 500) {
    super(code);
  }
}

export function privateJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

const SESSION_COOKIE = "ruleripple_firebase_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function firebaseConfig() {
  const apiKey = process.env.FIREBASE_API_KEY;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!apiKey || !projectId) throw new FirebaseServerError("FIREBASE_NOT_CONFIGURED", 503);
  return { apiKey, projectId };
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  try { return await response.json() as Record<string, unknown>; } catch { throw new FirebaseServerError("FIREBASE_UNAVAILABLE", 503); }
}

function firebaseErrorCode(value: Record<string, unknown>) {
  const error = value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : null;
  return typeof error?.message === "string" ? error.message : "FIREBASE_UNAVAILABLE";
}

function decodeTokenClaims(idToken: string): Record<string, unknown> {
  const payload = idToken.split(".")[1];
  if (!payload) throw new FirebaseServerError("INVALID_SESSION", 401);
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(atob(normalized)) as Record<string, unknown>;
  } catch { throw new FirebaseServerError("INVALID_SESSION", 401); }
}

function sessionFromIdentityResponse(value: Record<string, unknown>): FirebaseSession {
  const idToken = typeof value.idToken === "string" ? value.idToken : typeof value.id_token === "string" ? value.id_token : "";
  const refreshToken = typeof value.refreshToken === "string" ? value.refreshToken : typeof value.refresh_token === "string" ? value.refresh_token : "";
  const claims = decodeTokenClaims(idToken);
  const uid = typeof value.localId === "string" ? value.localId : typeof value.user_id === "string" ? value.user_id : typeof claims.user_id === "string" ? claims.user_id : typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof value.email === "string" ? value.email : typeof claims.email === "string" ? claims.email : "";
  if (!uid || !email || !refreshToken) throw new FirebaseServerError("INVALID_SESSION", 401);
  return { user: { uid, email }, idToken, refreshToken };
}

export async function authenticateWithFirebase(mode: "signin" | "signup", email: string, password: string): Promise<FirebaseSession> {
  const { apiKey } = firebaseConfig();
  const method = mode === "signup" ? "signUp" : "signInWithPassword";
  let response: Response;
  try {
    response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
      cache: "no-store",
    });
  } catch { throw new FirebaseServerError("FIREBASE_UNAVAILABLE", 503); }
  const value = await jsonResponse(response);
  if (!response.ok) throw new FirebaseServerError(firebaseErrorCode(value), response.status === 429 ? 429 : 400);
  return sessionFromIdentityResponse(value);
}

export async function refreshFirebaseSession(refreshToken: string): Promise<FirebaseSession> {
  const { apiKey } = firebaseConfig();
  let response: Response;
  try {
    response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
      cache: "no-store",
    });
  } catch { throw new FirebaseServerError("FIREBASE_UNAVAILABLE", 503); }
  const value = await jsonResponse(response);
  if (!response.ok) throw new FirebaseServerError("INVALID_SESSION", 401);
  return sessionFromIdentityResponse(value);
}

export async function authenticatedFirebaseSession(request: Request): Promise<FirebaseSession> {
  const refreshToken = sessionCookieValue(request);
  if (!refreshToken) throw new FirebaseServerError("UNAUTHENTICATED", 401);
  return refreshFirebaseSession(refreshToken);
}

// Machine intake accepts a verified workspace ID token; browser intake keeps
// using the existing HttpOnly session and same-origin CSRF check. No secrets
// are returned to browser JavaScript or stored in request records.
export async function authenticatedIntakeSession(request: Request): Promise<{ session: FirebaseSession; bearer: boolean }> {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    if (request.method !== "GET") assertSameOrigin(request);
    return { session: await authenticatedFirebaseSession(request), bearer: false };
  }
  const match = /^Bearer ([A-Za-z0-9_.-]{20,8192})$/.exec(authorization);
  if (!match) throw new FirebaseServerError("INVALID_SESSION", 401);
  const idToken = match[1], { apiKey, projectId } = firebaseConfig();
  if (idToken.startsWith("rragent1.")) throw new FirebaseServerError("USE_SCOPED_AGENT_ENDPOINT", 401);
  let response: Response;
  try { response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken }), cache: "no-store", signal: AbortSignal.timeout(15_000) }); }
  catch { throw new FirebaseServerError("FIREBASE_UNAVAILABLE", 503); }
  const value = await jsonResponse(response);
  const account = Array.isArray(value.users) && value.users.length === 1 ? value.users[0] : null;
  if (!response.ok || !account || account.disabled || typeof account.localId !== "string" || typeof account.email !== "string") throw new FirebaseServerError("INVALID_SESSION", 401);
  const claims = decodeTokenClaims(idToken);
  if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}` || claims.sub !== account.localId || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now() || typeof claims.auth_time !== "number" || Number(account.validSince ?? 0) > claims.auth_time) throw new FirebaseServerError("INVALID_SESSION", 401);
  return { session: { user: { uid: account.localId, email: account.email }, idToken, refreshToken: "" }, bearer: true };
}

export function sessionCookieValue(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const entry = cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${SESSION_COOKIE}=`));
  if (!entry) return null;
  try { return decodeURIComponent(entry.slice(SESSION_COOKIE.length + 1)); }
  catch { return null; }
}

export function setSessionCookie(response: NextResponse, refreshToken: string) {
  response.cookies.set(SESSION_COOKIE, refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) throw new FirebaseServerError("INVALID_ORIGIN", 403);
}

export async function readJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new FirebaseServerError("JSON_CONTENT_TYPE_REQUIRED", 415);
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new FirebaseServerError("REQUEST_BODY_TOO_LARGE", 413);
  let source: string;
  try { source = await request.text(); }
  catch { throw new FirebaseServerError("INVALID_JSON_BODY", 400); }
  if (new TextEncoder().encode(source).byteLength > maxBytes) throw new FirebaseServerError("REQUEST_BODY_TOO_LARGE", 413);
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new FirebaseServerError("INVALID_JSON_BODY", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FirebaseServerError("INVALID_JSON_BODY", 400);
  return value as Record<string, unknown>;
}

type FirestoreValue = {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  timestampValue?: string;
  stringValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
};
interface FirestoreDocument { name: string; fields?: Record<string, FirestoreValue>; createTime?: string; updateTime?: string; }

function decodeFirestoreValue(value: FirestoreValue): unknown {
  if ("nullValue" in value) return null;
  if (typeof value.booleanValue === "boolean") return value.booleanValue;
  if (typeof value.integerValue === "string") return Number(value.integerValue);
  if (typeof value.doubleValue === "number") return value.doubleValue;
  if (typeof value.timestampValue === "string") return value.timestampValue;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(decodeFirestoreValue);
  if (value.mapValue) return Object.fromEntries(Object.entries(value.mapValue.fields ?? {}).map(([key, item]) => [key, decodeFirestoreValue(item)]));
  return undefined;
}

function decodeDocument(document: FirestoreDocument): Record<string, unknown> {
  return Object.fromEntries(Object.entries(document.fields ?? {}).map(([key, value]) => [key, decodeFirestoreValue(value)]));
}

const stringValue = (value: string): FirestoreValue => ({ stringValue: value });
const integerValue = (value: number): FirestoreValue => ({ integerValue: String(value) });

function firestoreBase(projectId: string) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
}

async function firestoreRequest(url: string, idToken: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, headers: { ...init?.headers, authorization: `Bearer ${idToken}` }, cache: "no-store" });
  } catch { throw new FirebaseServerError("FIREBASE_UNAVAILABLE", 503); }
}

export interface StoredWorkspace {
  app: AppState;
  revision: number;
  segmentCount: number;
  updateTime: string;
}

// Separate from the client-editable workspace and its export/restore history.
// These records contain a credential fingerprint, never an owner refresh token.
export async function agentConnectionRecords(session: FirebaseSession, id?: string): Promise<StoredAgentConnection[]> {
  if (id && !/^[a-f0-9-]{36}$/.test(id)) throw new FirebaseServerError("INVALID_AGENT_CONNECTION", 400);
  const url = `${firestoreBase(firebaseConfig().projectId)}/workspaces/${encodeURIComponent(session.user.uid)}/agentConnections`;
  const records: StoredAgentConnection[] = [];
  let page = "";
  do {
    const response = await firestoreRequest(id ? `${url}/${id}` : `${url}?pageSize=100${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, session.idToken);
    if (id && response.status === 404) return [];
    if (!response.ok) throw new FirebaseServerError("AGENT_CONNECTION_STORE_UNAVAILABLE", 503);
    const result = await jsonResponse(response);
    const documents = id ? [result] : (result.documents ?? []) as Record<string, unknown>[];
    for (const document of documents) {
      const decoded = decodeDocument(document as unknown as FirestoreDocument);
      try {
        const record = JSON.parse(String(decoded.payload)) as StoredAgentConnection;
        if (decoded.ownerId !== session.user.uid || !record.id || !record.tokenHash) throw new Error();
        records.push(record);
      } catch { throw new FirebaseServerError("AGENT_CONNECTION_STORE_INVALID", 503); }
    }
    page = !id && typeof result.nextPageToken === "string" ? result.nextPageToken : "";
  } while (page);
  return records;
}

export async function createAgentConnectionRecord(session: FirebaseSession, record: StoredAgentConnection) {
  const url = `${firestoreBase(firebaseConfig().projectId)}/workspaces/${encodeURIComponent(session.user.uid)}/agentConnections/${record.id}?currentDocument.exists=false`;
  const response = await firestoreRequest(url, session.idToken, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields: { ownerId: stringValue(session.user.uid), payload: stringValue(JSON.stringify(record)) } }) });
  if (!response.ok) throw new FirebaseServerError("AGENT_CONNECTION_SAVE_FAILED", 503);
}

export async function revokeAgentConnectionRecord(session: FirebaseSession, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new FirebaseServerError("INVALID_AGENT_CONNECTION", 400);
  // Deletion is permanent revocation. The server never reuses a connection ID.
  const url = `${firestoreBase(firebaseConfig().projectId)}/workspaces/${encodeURIComponent(session.user.uid)}/agentConnections/${id}`;
  const response = await firestoreRequest(url, session.idToken, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new FirebaseServerError("AGENT_CONNECTION_REVOKE_FAILED", 503);
}

// A separate, signed receipt store cannot be rewritten by workspace imports.
// CAS protects concurrent dispatches; root preconditions bind a receipt to the
// authorization that was freshly read without modifying the budget ledger.
async function notificationMac(payload: string) {
  const secret = process.env.AGENT_CREDENTIAL_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new FirebaseServerError("AGENT_NOTIFICATIONS_NOT_CONFIGURED", 503);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`notification-v1:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function notificationRecords(session: FirebaseSession, id?: string): Promise<{ record: import("./github-notifications").BudgetNotification; updateTime: string }[]> {
  if (id && !/^[a-f0-9]{64}$/.test(id)) throw new FirebaseServerError("INVALID_NOTIFICATION_ID", 400);
  const url = `${firestoreBase(firebaseConfig().projectId)}/workspaces/${encodeURIComponent(session.user.uid)}/agentNotifications`;
  const records: { record: import("./github-notifications").BudgetNotification; updateTime: string }[] = [];
  let page = "";
  do {
    const response = await firestoreRequest(id ? `${url}/${id}` : `${url}?pageSize=100${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, session.idToken);
    if (id && response.status === 404) return [];
    if (!response.ok) throw new FirebaseServerError("NOTIFICATION_STORE_UNAVAILABLE", 503);
    const result = await jsonResponse(response);
    const documents = (id ? [result] : result.documents ?? []) as unknown as FirestoreDocument[];
    for (const document of documents) {
      const decoded = decodeDocument(document);
      if (decoded.ownerId !== session.user.uid || typeof decoded.payload !== "string" || decoded.signature !== await notificationMac(`${session.user.uid}:${decoded.payload}`) || !document.updateTime) throw new FirebaseServerError("NOTIFICATION_STORE_INVALID", 503);
      const record = JSON.parse(decoded.payload) as import("./github-notifications").BudgetNotification;
      // A valid signature cannot be copied to another notification document.
      if (!/^[a-f0-9]{64}$/.test(record.id) || document.name?.split("/").at(-1) !== record.id || (id && id !== record.id)) throw new FirebaseServerError("NOTIFICATION_STORE_INVALID", 503);
      records.push({ record, updateTime: document.updateTime });
    }
    page = !id && typeof result.nextPageToken === "string" ? result.nextPageToken : "";
  } while (page);
  return records;
}
export async function saveNotificationRecord(session: FirebaseSession, record: import("./github-notifications").BudgetNotification, expectedUpdateTime: string | null, workspaceUpdateTime?: string) {
  if (!/^[a-f0-9]{64}$/.test(record.id)) throw new FirebaseServerError("INVALID_NOTIFICATION_ID", 400);
  const { projectId } = firebaseConfig(), base = firestoreBase(projectId);
  const rootName = `projects/${projectId}/databases/(default)/documents/workspaces/${session.user.uid}`;
  const payload = JSON.stringify(record);
  const writes: Record<string, unknown>[] = [];
  writes.push({ update: { name: `${rootName}/agentNotifications/${record.id}`, fields: { ownerId: stringValue(session.user.uid), payload: stringValue(payload), signature: stringValue(await notificationMac(`${session.user.uid}:${payload}`)) } }, currentDocument: expectedUpdateTime ? { updateTime: expectedUpdateTime } : { exists: false } });
  let transaction: string | undefined;
  let committed = false;
  try {
    if (workspaceUpdateTime) {
      // An optimistic read transaction verifies the workspace and connection
      // at commit without rewriting either document or creating ledger events.
      const start = await firestoreRequest(`${base}:beginTransaction`, session.idToken, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ options: { readWrite: { concurrencyMode: "OPTIMISTIC" } } }) });
      const value = await jsonResponse(start);
      if (!start.ok || typeof value.transaction !== "string") throw new FirebaseServerError("NOTIFICATION_TRANSACTION_FAILED", 503);
      transaction = value.transaction;
      const query = `?transaction=${encodeURIComponent(transaction)}`;
      const rootResponse = await firestoreRequest(`${base}/workspaces/${encodeURIComponent(session.user.uid)}${query}`, session.idToken);
      const root = await jsonResponse(rootResponse);
      if (!rootResponse.ok || root.updateTime !== workspaceUpdateTime) throw new FirebaseServerError("NOTIFICATION_CONFLICT", 409);
      const connectionResponse = await firestoreRequest(`${base}/workspaces/${encodeURIComponent(session.user.uid)}/agentConnections/${encodeURIComponent(record.connectionId)}${query}`, session.idToken);
      if (!connectionResponse.ok) throw new FirebaseServerError("AGENT_CONNECTION_REVOKED", 403);
      const connection = JSON.parse(String(decodeDocument(await jsonResponse(connectionResponse) as unknown as FirestoreDocument).payload)) as StoredAgentConnection;
      if (connection.id !== record.connectionId || connection.revokedAt || !Number.isFinite(Date.parse(connection.expiresAt)) || Date.parse(connection.expiresAt) <= Date.now()) throw new FirebaseServerError("AGENT_CONNECTION_REVOKED", 403);
    }
    const response = await firestoreRequest(`${base}:commit`, session.idToken, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes, ...(transaction ? { transaction } : {}) }) });
    if (!response.ok) {
      const code = firebaseErrorCode(await jsonResponse(response));
      if (code.includes("FAILED_PRECONDITION") || code.includes("ABORTED") || code.includes("ALREADY_EXISTS")) throw new FirebaseServerError("NOTIFICATION_CONFLICT", 409);
      throw new FirebaseServerError("NOTIFICATION_SAVE_FAILED", 503);
    }
    committed = true;
  } finally {
    if (transaction && !committed) await firestoreRequest(`${base}:rollback`, session.idToken, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transaction }) }).catch(() => {});
  }
}

export async function readFirebaseWorkspace(session: FirebaseSession): Promise<StoredWorkspace | null> {
  const { projectId } = firebaseConfig();
  const base = firestoreBase(projectId);
  const rootResponse = await firestoreRequest(`${base}/workspaces/${encodeURIComponent(session.user.uid)}`, session.idToken);
  if (rootResponse.status === 404) return null;
  const rootDocument = await jsonResponse(rootResponse) as unknown as FirestoreDocument;
  if (!rootResponse.ok || !rootDocument.updateTime) throw new FirebaseServerError("CLOUD_WORKSPACE_INVALID", 502);
  const root = decodeDocument(rootDocument);
  if (root.ownerId !== session.user.uid) throw new FirebaseServerError("CLOUD_WORKSPACE_INVALID", 422);
  const manifest = safeCloudWorkspaceManifest(root);
  if (manifest) {
    const documents = await Promise.all(Array.from({ length: manifest.segmentCount }, async (_, index) => {
      const id = String(index).padStart(3, "0");
      const response = await firestoreRequest(`${base}/workspaces/${encodeURIComponent(session.user.uid)}/segments/${id}`, session.idToken);
      const document = await jsonResponse(response) as unknown as FirestoreDocument;
      if (!response.ok) throw new FirebaseServerError("CLOUD_SEGMENT_INVALID", 422);
      return decodeDocument(document);
    }));
    const payloads = documents.map((document, index) => {
      if (document.ownerId !== session.user.uid || document.index !== index || typeof document.payload !== "string") throw new FirebaseServerError("CLOUD_SEGMENT_INVALID", 422);
      return document.payload;
    });
    const app = restoreSegmentedAppState(payloads);
    if (!app) throw new FirebaseServerError("CLOUD_WORKSPACE_INVALID", 422);
    return { app, revision: manifest.revision, segmentCount: manifest.segmentCount, updateTime: rootDocument.updateTime };
  }
  const legacy = safeCloudWorkspaceDocument(root);
  if (!legacy) throw new FirebaseServerError("CLOUD_WORKSPACE_INVALID", 422);
  return { app: legacy.state, revision: legacy.revision, segmentCount: 0, updateTime: rootDocument.updateTime };
}

export async function writeFirebaseWorkspace(session: FirebaseSession, input: unknown, expectedSerialized: string | null, executionWrite = false, clientWrite = false): Promise<{ app: AppState; revision: number; changed: boolean }> {
  const app = safeAppState(input);
  if (!app) throw new FirebaseServerError("INVALID_WORKSPACE", 400);
  const nextSerialized = JSON.stringify(app);
  const current = await readFirebaseWorkspace(session);
  if (clientWrite) {
    try { assertClientOperatorState(current?.app ?? null, app); assertInboxUnchanged(current?.app.data, app.data); }
    catch (error) { if (error instanceof ExecutionError) throw new FirebaseServerError(error.message, 409); if (error instanceof InboxError) throw new FirebaseServerError("INBOX_SERVER_OWNED", 409); throw error; }
  }
  if (current) {
    if (!executionWrite && current.app.data.executions.some((item) => item.status === "approved" && item.attempt?.state === "dispatching")) throw new FirebaseServerError("EXECUTION_IN_PROGRESS", 409);
    const decision = cloudWriteDecision(JSON.stringify(current.app), expectedSerialized ?? "", nextSerialized);
    if (decision === "conflict") throw new FirebaseServerError("CLOUD_CONFLICT", 409);
    if (decision === "noop") return { app: current.app, revision: current.revision, changed: false };
  } else if (expectedSerialized !== null) {
    throw new FirebaseServerError("CLOUD_CONFLICT", 409);
  }

  const { projectId } = firebaseConfig();
  const base = firestoreBase(projectId);
  const rootName = `projects/${projectId}/databases/(default)/documents/workspaces/${session.user.uid}`;
  const segments = segmentAppState(app);
  const revision = (current?.revision ?? 0) + 1;
  const writes: Record<string, unknown>[] = segments.map((payload, index) => ({
    update: {
      name: `${rootName}/segments/${String(index).padStart(3, "0")}`,
      fields: { ownerId: stringValue(session.user.uid), index: integerValue(index), payload: stringValue(payload) },
    },
  }));
  for (let index = segments.length; index < (current?.segmentCount ?? 0); index += 1) writes.push({ delete: `${rootName}/segments/${String(index).padStart(3, "0")}` });
  writes.push({
    update: {
      name: rootName,
      fields: {
        schemaVersion: integerValue(CLOUD_SCHEMA_VERSION),
        ownerId: stringValue(session.user.uid),
        ownerEmail: stringValue(session.user.email),
        revision: integerValue(revision),
        segmentCount: integerValue(segments.length),
        storageLayout: stringValue("segmented-v1"),
      },
    },
    updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }],
    currentDocument: current ? { updateTime: current.updateTime } : { exists: false },
  });
  const response = await firestoreRequest(`${base}:commit`, session.idToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ writes }),
  });
  if (!response.ok) {
    const error = await jsonResponse(response);
    const code = firebaseErrorCode(error);
    if (code.includes("FAILED_PRECONDITION") || code.includes("ABORTED")) throw new FirebaseServerError("CLOUD_CONFLICT", 409);
    throw new FirebaseServerError("CLOUD_SAVE_FAILED", 502);
  }
  return { app, revision, changed: true };
}
