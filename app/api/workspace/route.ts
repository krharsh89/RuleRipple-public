import { assertSameOrigin, authenticatedFirebaseSession, clearSessionCookie, FirebaseServerError, privateJson, readFirebaseWorkspace, readJsonObject, setSessionCookie, writeFirebaseWorkspace } from "../../../lib/firebase-server";

function errorResponse(error: unknown) {
  const known = error instanceof FirebaseServerError ? error : new FirebaseServerError("WORKSPACE_REQUEST_FAILED", 500);
  const response = privateJson({ error: known.code }, { status: known.status });
  if (known.status === 401) clearSessionCookie(response);
  return response;
}

export async function GET(request: Request) {
  try {
    const session = await authenticatedFirebaseSession(request);
    const stored = await readFirebaseWorkspace(session);
    if (!stored) {
      const response = privateJson({ error: "WORKSPACE_NOT_FOUND" }, { status: 404 });
      setSessionCookie(response, session.refreshToken);
      return response;
    }
    const response = privateJson({ app: stored.app, revision: stored.revision });
    setSessionCookie(response, session.refreshToken);
    return response;
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await authenticatedFirebaseSession(request);
    const input = await readJsonObject(request, 5_000_000) as { app?: unknown; expectedSerialized?: unknown };
    if (input.expectedSerialized !== null && typeof input.expectedSerialized !== "string") throw new FirebaseServerError("INVALID_EXPECTED_STATE", 400);
    const saved = await writeFirebaseWorkspace(session, input.app, input.expectedSerialized, false, true);
    const response = privateJson({ app: saved.app, revision: saved.revision, changed: saved.changed });
    setSessionCookie(response, session.refreshToken);
    return response;
  } catch (error) { return errorResponse(error); }
}
