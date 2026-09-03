import "server-only";

import { FirebaseServerError, readFirebaseWorkspace, writeFirebaseWorkspace, type FirebaseSession } from "./firebase-server";
import { assertGitHubPullRequestReady, getGitHubPullRequest, inspectGitHubBudget, mergeGitHubPullRequest } from "./github-server";
import { assertPinnedIntake, executeClaimedAction, ExecutionError } from "./operator-execution-core";
import { validateBatchSelections } from "./operator-batch";

export async function executeStoredGitHubAction(session: FirebaseSession, githubToken: string, executionId: string) {
  try {
    return await executeClaimedAction(executionId, {
      read: async () => { const stored = await readFirebaseWorkspace(session); if (!stored) throw new FirebaseServerError("WORKSPACE_NOT_FOUND", 404); return stored.app; },
      write: async (next, expected) => (await writeFirebaseWorkspace(session, next, JSON.stringify(expected), true)).app,
      inspect: (existing) => getGitHubPullRequest(githubToken, String(existing.arguments.repository_full_name), Number(existing.arguments.pr_number)),
      validate: async (app, existing, pull) => {
        assertGitHubPullRequestReady(pull, String(existing.arguments.expected_head_sha), false);
        await assertPinnedIntake(app, existing, pull);
        if (existing.budgetBinding) {
          const binding = existing.budgetBinding;
          validateBatchSelections([{ reference: `${pull.repositoryFullName}#${pull.number}`, budget: binding }]);
          const verified = await inspectGitHubBudget(githubToken, pull, binding);
          if (verified.amount !== binding.amount || verified.baseSha !== binding.baseSha) throw new ExecutionError("GITHUB_BUDGET_CHANGED");
        }
      },
      merge: (existing, validateCurrent) => mergeGitHubPullRequest(githubToken, {
        repositoryFullName: String(existing.arguments.repository_full_name), number: Number(existing.arguments.pr_number), expectedHeadSha: String(existing.arguments.expected_head_sha),
        mergeMethod: existing.arguments.merge_method as "merge" | "squash" | "rebase",
        commitTitle: typeof existing.arguments.commit_title === "string" ? existing.arguments.commit_title : undefined,
        commitMessage: typeof existing.arguments.commit_message === "string" ? existing.arguments.commit_message : undefined,
        allowAlreadyMerged: false, validateCurrent,
      }),
    });
  } catch (error) { if (error instanceof ExecutionError) throw new FirebaseServerError(error.message, 409); throw error; }
}
