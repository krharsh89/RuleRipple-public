import { NextResponse } from "next/server";
import { authenticatedFirebaseSession, FirebaseServerError } from "../../../../lib/firebase-server";
import { githubAuthorizeUrl, GitHubServerError, requireOperatorAccess, setGitHubOAuthState } from "../../../../lib/github-server";

export async function GET(request: Request) {
  try {
    const session = await authenticatedFirebaseSession(request);
    requireOperatorAccess(session.user.email);
    const state = crypto.randomUUID().replace(/-/g, "");
    const response = NextResponse.redirect(githubAuthorizeUrl(new URL(request.url).origin, state));
    setGitHubOAuthState(response, state, session.user.uid);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  } catch (error) {
    const status = error instanceof FirebaseServerError || error instanceof GitHubServerError ? error.status : 500;
    const response = NextResponse.redirect(new URL(`/?github=error&code=${status}`, request.url));
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  }
}
