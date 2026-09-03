import { BatchError, parsePullReference, reviewRequestBatch } from "../../../../lib/operator-batch";
import { assertSameOrigin, authenticatedFirebaseSession, FirebaseServerError, privateJson, readFirebaseWorkspace, readJsonObject, setSessionCookie, writeFirebaseWorkspace } from "../../../../lib/firebase-server";
import { getGitHubPullRequest, githubAccessToken, GitHubServerError, inspectGitHubBudget, requireOperatorAccess } from "../../../../lib/github-server";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await authenticatedFirebaseSession(request);
    requireOperatorAccess(session.user.email);
    const token = githubAccessToken(request, session.user.uid);
    if (!token) throw new GitHubServerError("GITHUB_NOT_CONNECTED", 409);
    const stored = await readFirebaseWorkspace(session);
    if (!stored) throw new FirebaseServerError("WORKSPACE_NOT_FOUND", 404);
    const input = await readJsonObject(request, 8_192);
    const result = await reviewRequestBatch(stored.app, input.selections, async (selection) => {
      const target = parsePullReference(selection.reference);
      const pull = await getGitHubPullRequest(token, target.repository, target.number);
      const budget = selection.budget ? await inspectGitHubBudget(token, pull, selection.budget) : undefined;
      return { pull, budget };
    });
    const saved = await writeFirebaseWorkspace(session, result.app, JSON.stringify(stored.app));
    const response = privateJson({ app: saved.app, batch: result.batch });
    setSessionCookie(response, session.refreshToken);
    return response;
  } catch (error) {
    if (error instanceof BatchError) return privateJson({ error: "INVALID_REQUEST_BATCH", detail: error.message }, { status: 422 });
    const known = error instanceof FirebaseServerError || error instanceof GitHubServerError ? error : new FirebaseServerError("BATCH_REVIEW_FAILED", 502);
    return privateJson({ error: known.code }, { status: known.status });
  }
}
