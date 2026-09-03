import { NextResponse } from "next/server";
import { authenticatedFirebaseSession } from "../../../../lib/firebase-server";
import { clearGitHubAccessToken, clearGitHubOAuthState, exchangeGitHubOAuthCode, githubOAuthState, requireOperatorAccess, setGitHubAccessToken } from "../../../../lib/github-server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const session = await authenticatedFirebaseSession(request);
    requireOperatorAccess(session.user.email);
    const code = url.searchParams.get("code") ?? "";
    const suppliedState = url.searchParams.get("state") ?? "";
    const expectedState = githubOAuthState(request, session.user.uid) ?? "";
    if (!code || !suppliedState || suppliedState !== expectedState) throw new Error("INVALID_OAUTH_STATE");
    const token = await exchangeGitHubOAuthCode(code, url.origin);
    const response = NextResponse.redirect(new URL("/?github=connected", request.url));
    clearGitHubOAuthState(response);
    setGitHubAccessToken(response, token, session.user.uid);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  } catch {
    const response = NextResponse.redirect(new URL("/?github=error", request.url));
    clearGitHubAccessToken(response);
    clearGitHubOAuthState(response);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  }
}
