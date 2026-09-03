import "server-only";

import { verifiedBudgetAmount, type BudgetBinding } from "./operator-batch";

import { NextResponse } from "next/server";
import { FirebaseServerError } from "./firebase-server";

const ACCESS_COOKIE = "ruleripple_github_access";
const STATE_COOKIE = "ruleripple_github_oauth_state";
const GITHUB_USER_AGENT = "RuleRipple";
const ACCESS_MAX_AGE = 60 * 60 * 24 * 30;
const STATE_MAX_AGE = 60 * 10;

export interface GitHubPullRequest {
  baseSha?: string;
  repositoryFullName: string;
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  mergeable: boolean | null;
  merged: boolean;
  mergedSha: string | null;
  headSha: string;
  headRef: string;
  baseRef: string;
  htmlUrl: string;
  author: string;
}

export interface GitHubMergeReceipt {
  merged: boolean;
  sha: string;
  message: string;
  resultUrl: string;
}

export class GitHubServerError extends Error {
  constructor(public readonly code: string, public readonly status = 500) {
    super(code);
  }
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const entry = cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  if (!entry) return null;
  try { return decodeURIComponent(entry.slice(name.length + 1)); }
  catch { return null; }
}

function secureCookie() {
  return process.env.NODE_ENV === "production";
}

function githubOAuthConfig() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new GitHubServerError("GITHUB_OAUTH_NOT_CONFIGURED", 503);
  return { clientId, clientSecret };
}

export function githubOAuthIsConfigured() {
  return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

function boundCookieValue(value: string | null, ownerId: string) {
  if (!value) return null;
  const separator = value.indexOf(":");
  if (separator < 1 || value.slice(0, separator) !== ownerId) return null;
  return value.slice(separator + 1) || null;
}

export function githubAccessToken(request: Request, ownerId: string): string | null {
  return boundCookieValue(cookieValue(request, ACCESS_COOKIE), ownerId);
}

export function githubOAuthState(request: Request, ownerId: string): string | null {
  return boundCookieValue(cookieValue(request, STATE_COOKIE), ownerId);
}

export function setGitHubOAuthState(response: NextResponse, state: string, ownerId: string) {
  response.cookies.set(STATE_COOKIE, `${ownerId}:${state}`, { httpOnly: true, secure: secureCookie(), sameSite: "lax", path: "/api/github", maxAge: STATE_MAX_AGE });
}

export function clearGitHubOAuthState(response: NextResponse) {
  response.cookies.set(STATE_COOKIE, "", { httpOnly: true, secure: secureCookie(), sameSite: "lax", path: "/api/github", maxAge: 0 });
}

export function setGitHubAccessToken(response: NextResponse, token: string, ownerId: string) {
  response.cookies.set(ACCESS_COOKIE, `${ownerId}:${token}`, { httpOnly: true, secure: secureCookie(), sameSite: "lax", path: "/", maxAge: ACCESS_MAX_AGE });
}

export function clearGitHubAccessToken(response: NextResponse) {
  response.cookies.set(ACCESS_COOKIE, "", { httpOnly: true, secure: secureCookie(), sameSite: "lax", path: "/", maxAge: 0 });
}

export function githubAuthorizeUrl(origin: string, state: string) {
  const { clientId } = githubOAuthConfig();
  const callback = `${origin}/api/github/callback`;
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: callback, scope: "public_repo read:user", state, allow_signup: "false" });
  return `https://github.com/login/oauth/authorize?${query.toString()}`;
}

async function githubJson(response: Response): Promise<Record<string, unknown>> {
  try { return await response.json() as Record<string, unknown>; }
  catch { throw new GitHubServerError("GITHUB_INVALID_RESPONSE", 502); }
}

export async function exchangeGitHubOAuthCode(code: string, origin: string): Promise<string> {
  const { clientId, clientSecret } = githubOAuthConfig();
  let response: Response;
  try {
    response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": GITHUB_USER_AGENT },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: `${origin}/api/github/callback` }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new GitHubServerError("GITHUB_UNAVAILABLE", 503); }
  const value = await githubJson(response);
  const token = typeof value.access_token === "string" ? value.access_token : "";
  if (!response.ok || !token) throw new GitHubServerError(typeof value.error === "string" ? `GITHUB_OAUTH_${value.error.toUpperCase()}` : "GITHUB_OAUTH_FAILED", 400);
  return token;
}

async function githubApi(path: string, token: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": GITHUB_USER_AGENT,
        "x-github-api-version": "2022-11-28",
        ...init?.headers,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new GitHubServerError("GITHUB_UNAVAILABLE", 503); }
  if (response.status === 204) return {};
  const value = await githubJson(response);
  if (!response.ok) {
    const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
    if (response.status === 401) throw new GitHubServerError("GITHUB_CONNECTION_EXPIRED", 401);
    if (response.status === 403) throw new GitHubServerError("GITHUB_PERMISSION_DENIED", 403);
    if (response.status === 404) throw new GitHubServerError("GITHUB_TARGET_NOT_FOUND", 404);
    if (response.status === 405) throw new GitHubServerError("GITHUB_PULL_REQUEST_NOT_MERGEABLE", 409);
    if (response.status === 409 || message.includes("head branch")) throw new GitHubServerError("GITHUB_HEAD_CHANGED", 409);
    if (response.status === 422) throw new GitHubServerError("GITHUB_MERGE_REJECTED", 409);
    throw new GitHubServerError("GITHUB_REQUEST_FAILED", 502);
  }
  return value;
}

export async function dispatchBudgetConfirmation(token: string, repository: string, notificationId: string) {
  if (!/^[a-f0-9]{64}$/.test(notificationId)) throw new GitHubServerError("INVALID_NOTIFICATION", 400);
  // No arbitrary URLs, workflow paths, branches, commands, amounts, or secrets
  // are accepted from request authors. This workflow only verifies a receipt.
  const path = `/repos/${repositoryPath(repository)}/actions/workflows/ruleripple-confirmation.yml`;
  const workflow = await githubApi(path, token);
  if (workflow.state !== "active" || workflow.path !== ".github/workflows/ruleripple-confirmation.yml") throw new GitHubServerError("GITHUB_CONFIRMATION_WORKFLOW_UNAVAILABLE", 409);
  await githubApi(`${path}/dispatches`, token, { method: "POST", body: JSON.stringify({ ref: "main", inputs: { notification_id: notificationId } }) });
}

export async function getGitHubIdentity(token: string) {
  const value = await githubApi("/user", token);
  const login = typeof value.login === "string" ? value.login : "";
  if (!login) throw new GitHubServerError("GITHUB_INVALID_IDENTITY", 502);
  return { login, avatarUrl: typeof value.avatar_url === "string" ? value.avatar_url : null, htmlUrl: typeof value.html_url === "string" ? value.html_url : `https://github.com/${encodeURIComponent(login)}` };
}

function repositoryPath(repositoryFullName: string) {
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repositoryFullName)) throw new GitHubServerError("INVALID_GITHUB_REPOSITORY", 400);
  return repositoryFullName.split("/").map(encodeURIComponent).join("/");
}

export async function getGitHubPullRequest(token: string, repositoryFullName: string, number: number): Promise<GitHubPullRequest> {
  if (!Number.isSafeInteger(number) || number < 1) throw new GitHubServerError("INVALID_PULL_REQUEST_NUMBER", 400);
  const value = await githubApi(`/repos/${repositoryPath(repositoryFullName)}/pulls/${number}`, token);
  const head = value.head && typeof value.head === "object" ? value.head as Record<string, unknown> : {};
  const base = value.base && typeof value.base === "object" ? value.base as Record<string, unknown> : {};
  const user = value.user && typeof value.user === "object" ? value.user as Record<string, unknown> : {};
  const headSha = typeof head.sha === "string" ? head.sha : "";
  const htmlUrl = typeof value.html_url === "string" ? value.html_url : "";
  if (!/^[a-f0-9]{40,64}$/i.test(headSha) || !htmlUrl) throw new GitHubServerError("GITHUB_INVALID_PULL_REQUEST", 502);
  return {
    baseSha: typeof base.sha === "string" ? base.sha : undefined,
    repositoryFullName,
    number,
    title: typeof value.title === "string" ? value.title : `Pull request #${number}`,
    body: typeof value.body === "string" ? value.body : "",
    state: typeof value.state === "string" ? value.state : "unknown",
    draft: value.draft === true,
    mergeable: typeof value.mergeable === "boolean" ? value.mergeable : null,
    merged: value.merged === true,
    mergedSha: typeof value.merge_commit_sha === "string" && /^[a-f0-9]{40,64}$/i.test(value.merge_commit_sha) ? value.merge_commit_sha : null,
    headSha,
    headRef: typeof head.ref === "string" ? head.ref : "",
    baseRef: typeof base.ref === "string" ? base.ref : "",
    htmlUrl,
    author: typeof user.login === "string" ? user.login : "unknown",
  };
}

export function assertGitHubPullRequestReady(current: GitHubPullRequest, expectedHeadSha: string, allowAlreadyMerged = true): "ready" | "already_merged" {
  if (current.headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) throw new GitHubServerError("GITHUB_HEAD_CHANGED", 409);
  if (current.merged && current.mergedSha) {
    if (!allowAlreadyMerged) throw new GitHubServerError("GITHUB_PULL_REQUEST_ALREADY_MERGED", 409);
    return "already_merged";
  }
  if (current.state !== "open" || current.draft || current.merged) throw new GitHubServerError("GITHUB_PULL_REQUEST_NOT_OPEN", 409);
  if (current.mergeable === null) throw new GitHubServerError("GITHUB_MERGEABILITY_PENDING", 409);
  if (current.mergeable === false) throw new GitHubServerError("GITHUB_PULL_REQUEST_NOT_MERGEABLE", 409);
  return "ready";
}

export async function inspectGitHubBudget(token: string, pull: GitHubPullRequest, binding: BudgetBinding) {
  if (!pull.baseSha || !/^[a-f0-9]{40,64}$/i.test(pull.baseSha)) throw new GitHubServerError("GITHUB_INVALID_BASE_SHA", 502);
  const path = `/repos/${repositoryPath(pull.repositoryFullName)}/contents/${binding.path.split("/").map(encodeURIComponent).join("/")}`;
  async function readAt(sha: string, allowMissing: boolean) {
    let value;
    try { value = await githubApi(`${path}?ref=${encodeURIComponent(sha)}`, token); }
    catch (error) { if (allowMissing && error instanceof GitHubServerError && error.code === "GITHUB_TARGET_NOT_FOUND") return null; throw error; }
    if (value.type !== "file" || value.encoding !== "base64" || typeof value.content !== "string" || Number(value.size) > 100_000) throw new GitHubServerError("GITHUB_BUDGET_FILE_INVALID", 422);
    try { return JSON.parse(Buffer.from(value.content, "base64").toString("utf8")); }
    catch { throw new GitHubServerError("GITHUB_BUDGET_FILE_INVALID", 422); }
  }
  const [before, after] = await Promise.all([readAt(pull.baseSha, true), readAt(pull.headSha, false)]);
  return { ...binding, baseSha: pull.baseSha, amount: verifiedBudgetAmount(binding, before, after) };
}

export async function mergeGitHubPullRequest(token: string, input: { repositoryFullName: string; number: number; expectedHeadSha: string; mergeMethod: "merge" | "squash" | "rebase"; commitTitle?: string; commitMessage?: string; allowAlreadyMerged?: boolean; validateCurrent?: (pull: GitHubPullRequest) => void | Promise<void>; }): Promise<GitHubMergeReceipt> {
  const current = await getGitHubPullRequest(token, input.repositoryFullName, input.number);
  const state = assertGitHubPullRequestReady(current, input.expectedHeadSha, input.allowAlreadyMerged ?? true);
  if (state === "already_merged") return { merged: true, sha: current.mergedSha!, message: "Pull request was already merged at the authorized head.", resultUrl: current.htmlUrl };
  await input.validateCurrent?.(current);
  const value = await githubApi(`/repos/${repositoryPath(input.repositoryFullName)}/pulls/${input.number}/merge`, token, {
    method: "PUT",
    body: JSON.stringify({ sha: input.expectedHeadSha, merge_method: input.mergeMethod, ...(input.commitTitle ? { commit_title: input.commitTitle } : {}), ...(input.commitMessage ? { commit_message: input.commitMessage } : {}) }),
  });
  if (value.merged !== true) throw new GitHubServerError("GITHUB_MERGE_REJECTED", 409);
  if (typeof value.sha !== "string" || !/^[a-f0-9]{40,64}$/i.test(value.sha)) throw new GitHubServerError("GITHUB_INVALID_MERGE_RECEIPT", 502);
  return { merged: true, sha: value.sha, message: typeof value.message === "string" ? value.message : "Pull request merged.", resultUrl: current.htmlUrl };
}

function allowedOperatorEmails() {
  return (process.env.OPERATOR_ALLOWED_EMAILS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

export function operatorAccessIsConfigured() { return allowedOperatorEmails().length > 0; }

export function operatorAccessAllowed(email: string) {
  const configured = allowedOperatorEmails();
  return configured.length > 0 && configured.includes(email.trim().toLowerCase());
}

export function requireOperatorAccess(email: string) {
  if (!operatorAccessAllowed(email)) throw new FirebaseServerError("OPERATOR_ACCESS_DENIED", 403);
}
