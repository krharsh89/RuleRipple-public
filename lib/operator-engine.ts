import "server-only";

import { runRuleRippleOperatorCore } from "./operator-engine-core";
import { getGitHubPullRequest } from "./github-server";
export { ruleRippleOperatorModel } from "./operator-engine-core";
export type { OperatorTraceItem, OperatorRunResult } from "./operator-engine-core";

export async function runRuleRippleOperator(input: Omit<Parameters<typeof runRuleRippleOperatorCore>[0], "inspectPull"> & { githubToken?: string }) {
  return runRuleRippleOperatorCore({ ...input, inspectPull: input.githubToken ? (repository, number) => getGitHubPullRequest(input.githubToken!, repository, number) : undefined });
}
