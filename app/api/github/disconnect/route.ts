import { assertSameOrigin, authenticatedFirebaseSession, clearSessionCookie, FirebaseServerError, privateJson, setSessionCookie } from "../../../../lib/firebase-server";
import { clearGitHubAccessToken } from "../../../../lib/github-server";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await authenticatedFirebaseSession(request);
    const response = privateJson({ success: true });
    clearGitHubAccessToken(response);
    setSessionCookie(response, session.refreshToken);
    return response;
  } catch (error) {
    const known = error instanceof FirebaseServerError ? error : new FirebaseServerError("GITHUB_DISCONNECT_FAILED", 500);
    const response = privateJson({ error: known.code }, { status: known.status });
    if (known.status === 401) clearSessionCookie(response);
    return response;
  }
}
