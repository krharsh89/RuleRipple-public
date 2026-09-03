import { assertSameOrigin, authenticatedFirebaseSession, clearSessionCookie, FirebaseServerError, privateJson, readJsonObject, setSessionCookie } from "../../../../lib/firebase-server";
import { githubAccessToken, GitHubServerError, requireOperatorAccess } from "../../../../lib/github-server";
import { executeStoredGitHubAction } from "../../../../lib/operator-execution";

function executionString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new FirebaseServerError(`INVALID_${name.toUpperCase()}`, 400);
  return value.trim();
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await authenticatedFirebaseSession(request);
    requireOperatorAccess(session.user.email);
    const token = githubAccessToken(request, session.user.uid);
    if (!token) throw new GitHubServerError("GITHUB_NOT_CONNECTED", 409);
    const input = await readJsonObject(request, 1_024) as { execution_id?: unknown };
    const executionId = executionString(input.execution_id, "execution_id");
    const result = await executeStoredGitHubAction(session, token, executionId);
    const response = privateJson({ success: true, app: result.app, execution: result.execution, receipt: result.execution.receipt, duplicate: result.duplicate });
    setSessionCookie(response, session.refreshToken);
    return response;
  } catch (error) {
    const known = error instanceof FirebaseServerError ? error : error instanceof GitHubServerError ? error : new FirebaseServerError("OPERATOR_EXECUTION_FAILED", 500);
    const response = privateJson({ error: known.code }, { status: known.status });
    if (known.status === 401) clearSessionCookie(response);
    return response;
  }
}
