import type { AppState } from "./cloud-state";
import type { BatchSelection } from "./operator-batch";
import type { RequestBatch } from "./domain";
import type { AgentRequestInput, InboxView } from "./request-inbox";
import type { PortfolioReview } from "./operator-review";

export interface AuthenticatedUser {
  uid: string;
  email: string;
}

export class CloudApiError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly detail?: string) {
    super(code);
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { ...init, headers: { ...init?.headers, accept: "application/json" } }); }
  catch { throw new CloudApiError("FIREBASE_UNAVAILABLE", 503); }
  let value: Record<string, unknown> = {};
  try { value = await response.json() as Record<string, unknown>; } catch { /* Preserve the HTTP error below. */ }
  if (!response.ok) throw new CloudApiError(typeof value.error === "string" ? value.error : "CLOUD_REQUEST_FAILED", response.status, typeof value.detail === "string" ? value.detail : undefined);
  return value as T;
}

export async function getCloudSession(): Promise<AuthenticatedUser | null> {
  try { return (await requestJson<{ user: AuthenticatedUser }>("/api/session", { cache: "no-store" })).user; }
  catch (error) { if (error instanceof CloudApiError && error.status === 401) return null; throw error; }
}

export async function authenticateCloud(mode: "signin" | "signup", email: string, password: string): Promise<AuthenticatedUser> {
  return (await requestJson<{ user: AuthenticatedUser }>("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, email, password }),
  })).user;
}

export async function signOutCloud() {
  await requestJson<{ success: true }>("/api/session", { method: "DELETE" });
}

export async function loadCloudWorkspace(): Promise<AppState | null> {
  try { return (await requestJson<{ app: AppState }>("/api/workspace", { cache: "no-store" })).app; }
  catch (error) { if (error instanceof CloudApiError && error.status === 404) return null; throw error; }
}

export async function saveCloudWorkspace(app: AppState, expectedSerialized: string | null): Promise<AppState> {
  return (await requestJson<{ app: AppState }>("/api/workspace", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app, expectedSerialized }),
  })).app;
}

export interface OperatorConnectionStatus {
  operator_access: boolean;
  operator_access_configured?: boolean;
  oauth_configured: boolean;
  connected: boolean;
  connection_expired?: boolean;
  account?: { login: string; avatarUrl: string | null; htmlUrl: string };
  model_configured: boolean;
  model: string;
}

export interface OperatorTraceItem {
  tool: string;
  title: string;
  status: "completed" | "blocked";
  detail: string;
}

export interface OperatorRunResponse {
  app: AppState;
  message: string;
  trace: OperatorTraceItem[];
  pendingExecutionId: string | null;
  model: string;
  readOnly: boolean;
  portfolioReview: PortfolioReview | null;
}

export async function getOperatorConnectionStatus(): Promise<OperatorConnectionStatus> {
  return requestJson<OperatorConnectionStatus>("/api/github/status", { cache: "no-store" });
}

export async function disconnectGitHub() {
  await requestJson<{ success: true }>("/api/github/disconnect", { method: "POST" });
}

export async function runPolicyOperator(prompt: string, readOnly = true): Promise<OperatorRunResponse> {
  return requestJson<OperatorRunResponse>("/api/operator/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, readOnly }),
  });
}

export async function executeWithPolicyOperator(executionId: string): Promise<{ success: true; app: AppState }> {
  return requestJson<{ success: true; app: AppState }>("/api/operator/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ execution_id: executionId }),
  });
}

export async function reviewPolicyBatch(selections: BatchSelection[]): Promise<{ app: AppState; batch: RequestBatch }> {
  return requestJson("/api/operator/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selections }) });
}

export async function receiveInboxRequests(requests: AgentRequestInput[]): Promise<InboxView & { app: AppState; received: string[]; duplicates: string[] }> {
  return requestJson("/api/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests }) });
}
export async function decideInboxBudget(input: { request_id: string; decision: "approve" | "reject"; review_fingerprint: string; rationale: string }): Promise<InboxView & { app: AppState }> {
  return requestJson("/api/requests/decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}
