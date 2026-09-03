import { assertSameOrigin, clearSessionCookie, FirebaseServerError, privateJson, refreshFirebaseSession, sessionCookieValue, setSessionCookie } from "../../../lib/firebase-server";
import { clearGitHubAccessToken, clearGitHubOAuthState } from "../../../lib/github-server";

export async function GET(request: Request) {
  try {
    const refreshToken = sessionCookieValue(request);
    if (!refreshToken) throw new FirebaseServerError("UNAUTHENTICATED", 401);
    const session = await refreshFirebaseSession(refreshToken);
    const response = privateJson({ user: session.user });
    setSessionCookie(response, session.refreshToken);
    return response;
  } catch (error) {
    const known = error instanceof FirebaseServerError ? error : new FirebaseServerError("SESSION_FAILED", 500);
    const response = privateJson({ error: known.code }, { status: known.status });
    if (known.status === 401) clearSessionCookie(response);
    return response;
  }
}

export async function DELETE(request: Request) {
  try { assertSameOrigin(request); } catch (error) {
    const known = error instanceof FirebaseServerError ? error : new FirebaseServerError("INVALID_ORIGIN", 403);
    return privateJson({ error: known.code }, { status: known.status });
  }
  const response = privateJson({ success: true });
  clearSessionCookie(response);
  clearGitHubAccessToken(response);
  clearGitHubOAuthState(response);
  return response;
}
