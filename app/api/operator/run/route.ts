import { runRuleRippleOperator } from "../../../../lib/operator-engine";
import { assertSameOrigin, authenticatedFirebaseSession, clearSessionCookie, FirebaseServerError, privateJson, readFirebaseWorkspace, readJsonObject, setSessionCookie, writeFirebaseWorkspace } from "../../../../lib/firebase-server";
import { githubAccessToken, GitHubServerError, requireOperatorAccess } from "../../../../lib/github-server";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await authenticatedFirebaseSession(request);
    requireOperatorAccess(session.user.email);
    const input = await readJsonObject(request, 2_048) as { prompt?: unknown; readOnly?: unknown };
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.trim().length > 600 || (input.readOnly !== undefined && typeof input.readOnly !== "boolean")) throw new FirebaseServerError("INVALID_OPERATOR_REQUEST", 400);
    const readOnly = input.readOnly !== false;
    const token = githubAccessToken(request, session.user.uid);
    if (!readOnly && !token) throw new GitHubServerError("GITHUB_NOT_CONNECTED", 409);
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new FirebaseServerError("OPERATOR_MODEL_NOT_CONFIGURED", 503);
    const stored = await readFirebaseWorkspace(session);
    if (!stored) throw new FirebaseServerError("WORKSPACE_NOT_FOUND", 404);
    const result = await runRuleRippleOperator({ app: stored.app, prompt: input.prompt, readOnly, githubToken: readOnly ? undefined : token ?? undefined, openaiKey });
    const changed = JSON.stringify(result.app) !== JSON.stringify(stored.app);
    if (readOnly && (changed || result.pendingExecutionId)) throw new FirebaseServerError("INVALID_OPERATOR_RESULT", 502);
    const saved = changed ? await writeFirebaseWorkspace(session, result.app, JSON.stringify(stored.app)) : { app: stored.app, revision: stored.revision, changed: false };
    const response = privateJson({ ...result, app: saved.app, revision: saved.revision });
    setSessionCookie(response, session.refreshToken);
    return response;
  } catch (error) {
    const known = error instanceof FirebaseServerError ? error : error instanceof GitHubServerError ? error : new FirebaseServerError("OPERATOR_RUN_FAILED", 502);
    const response = privateJson({ error: known.code }, { status: known.status });
    if (known.status === 401) clearSessionCookie(response);
    return response;
  }
}
