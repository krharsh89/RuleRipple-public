# Security policy

## Supported version

Security fixes apply to the latest commit on `main` and the current public RuleRipple release.

## Report a vulnerability

Please report suspected vulnerabilities through a [private GitHub security advisory](https://github.com/krharsh89/RuleRipple-public/security/advisories/new). Do not open a public issue for an unpatched vulnerability.

Include the affected URL or component, reproduction steps, observed impact, and any suggested mitigation. Do not include passwords, access tokens, personal data, or other secrets in the report.

## Current security boundary

RuleRipple is a browser-based policy simulator and policy-gated orchestration surface. It is not a cryptographic enforcement proxy for every MCP client and must not be used as the sole authority for money, medical access, safety decisions, regulated approvals, or paid provider capacity.

Cloud persistence requires an independently configured Firebase project and owner-scoped Firestore Security Rules. Use your own server configuration; `.env.example` contains setting names only. Never commit real credentials or use another deployment's private configuration.

The optional built-in policy operator has an additional bounded trust boundary:

- `OPENAI_API_KEY` and the GitHub OAuth client secret remain server-side and are never returned to browser JavaScript.
- The GitHub access token is stored in a Secure, HttpOnly, SameSite cookie bound to the authenticated Firebase user and is cleared on disconnect, sign-out, failed OAuth callback, or expired authorization.
- `OPERATOR_ALLOWED_EMAILS` limits model expenditure and GitHub connection access on the public site to explicitly named workspace owners.
- Pull-request text is untrusted input. RuleRipple parses only one dedicated `Policy intake` section, rejects missing, duplicate, unknown, invalid, or fenced declarations, and exposes only the typed result to the model.
- The model can read RuleRipple state and propose an allow-listed action, but it receives no GitHub mutation tool. The execution route accepts only a stored execution ID, revalidates its exact repository, pull-request number, inspected head SHA, mergeability, and source-intake fingerprint, durably saves approval and resource reservation, then invokes GitHub.
- GitHub merge actions do not report metered consumption. RuleRipple records the policy-authorized commitment and provider receipt without inventing usage.
