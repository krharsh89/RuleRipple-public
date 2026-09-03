import { assertSameOrigin, authenticateWithFirebase, FirebaseServerError, privateJson, readJsonObject, setSessionCookie } from "../../../lib/firebase-server";
import { clearGitHubAccessToken, clearGitHubOAuthState } from "../../../lib/github-server";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = await readJsonObject(request, 4_096) as { mode?: unknown; email?: unknown; password?: unknown };
    if (input.mode !== "signin" && input.mode !== "signup") throw new FirebaseServerError("INVALID_AUTH_MODE", 400);
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const password = typeof input.password === "string" ? input.password : "";
    if (!email || email.length > 254 || !email.includes("@")) throw new FirebaseServerError("INVALID_EMAIL", 400);
    if (password.length < 6 || password.length > 128) throw new FirebaseServerError("WEAK_PASSWORD", 400);
    const session = await authenticateWithFirebase(input.mode, email, password);
    const response = privateJson({ user: session.user });
    clearGitHubAccessToken(response);
    clearGitHubOAuthState(response);
    setSessionCookie(response, session.refreshToken);
    return response;
  } catch (error) {
    const known = error instanceof FirebaseServerError ? error : new FirebaseServerError("AUTHENTICATION_FAILED", 500);
    return privateJson({ error: known.code }, { status: known.status });
  }
}
