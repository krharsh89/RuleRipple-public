import { authenticatedFirebaseSession, clearSessionCookie, FirebaseServerError, privateJson, setSessionCookie } from "../../../../lib/firebase-server";
import { clearGitHubAccessToken, getGitHubIdentity, githubAccessToken, githubOAuthIsConfigured, GitHubServerError, operatorAccessAllowed, operatorAccessIsConfigured } from "../../../../lib/github-server";

export async function GET(request: Request) {
  try {
    const session = await authenticatedFirebaseSession(request);
    const allowed = operatorAccessAllowed(session.user.email);
    const configuration = { operator_access_configured: operatorAccessIsConfigured(), oauth_configured: githubOAuthIsConfigured(), model_configured: Boolean(process.env.OPENAI_API_KEY), model: "gpt-5.6-luna" };
    const token = githubAccessToken(request, session.user.uid);
    if (!allowed || !token) {
      const response = privateJson({ ...configuration, operator_access: allowed, connected: false });
      if (!allowed) clearGitHubAccessToken(response);
      setSessionCookie(response, session.refreshToken);
      return response;
    }
    try {
      const identity = await getGitHubIdentity(token);
      const response = privateJson({ ...configuration, operator_access: true, connected: true, account: identity });
      setSessionCookie(response, session.refreshToken);
      return response;
    } catch (error) {
      if (!(error instanceof GitHubServerError) || error.status !== 401) throw error;
      const response = privateJson({ ...configuration, operator_access: true, connected: false, connection_expired: true });
      clearGitHubAccessToken(response);
      setSessionCookie(response, session.refreshToken);
      return response;
    }
  } catch (error) {
    const known = error instanceof FirebaseServerError ? error : error instanceof GitHubServerError ? error : new FirebaseServerError("INTEGRATION_STATUS_FAILED", 500);
    const response = privateJson({ error: known.code }, { status: known.status });
    if (known.status === 401) clearSessionCookie(response);
    return response;
  }
}
