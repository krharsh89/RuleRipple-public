export interface AgentWorkflowStep {
  id: string;
  number: string;
  title: string;
  prompt: string;
}

export const agentPolicySetupSteps = [
  {
    id: "inspect-policy",
    number: "01",
    title: "Inspect policy",
    prompt: "Summarize the active policy, typed fields, resource settings, and automatic policy checks. Do not change anything.",
  },
  {
    id: "collect-rule",
    number: "02",
    title: "Define a gate",
    prompt: "Ask me which configured field, comparison, and value should define the first eligibility rule. Do not invent a threshold or change anything yet.",
  },
  {
    id: "add-rule",
    number: "03",
    title: "Add the gate",
    prompt: "Using only the eligibility field, comparison, and value I supplied, add the first typed rule and follow the active policy's configured authorization path.",
  },
] as const satisfies readonly AgentWorkflowStep[];

export const agentRequestSetupSteps = [
  {
    id: "inspect-inputs",
    number: "01",
    title: "Inspect inputs",
    prompt: "Summarize the configured request fields, resource demand, and minimum-useful-allocation inputs. Do not change anything.",
  },
  {
    id: "collect-requests",
    number: "02",
    title: "Collect values",
    prompt: "Ask me for every required value for the requests I want to evaluate. Do not infer, preload, or invent missing values.",
  },
  {
    id: "evaluate-requests",
    number: "03",
    title: "Add & evaluate",
    prompt: "After I provide the complete request values, add those requests, wait for human approval if required, then evaluate their outcomes, ranks, and allocations.",
  },
] as const satisfies readonly AgentWorkflowStep[];

export const agentWorkflowSteps = [
  {
    id: "inspect",
    number: "01",
    title: "Check policy",
    prompt: "Summarize the active policy, evaluate the current requests, and identify any request sourced from a GitHub pull request. Explain whether human approval is required for external actions. Do not change anything.",
  },
  {
    id: "import-pr",
    number: "02",
    title: "Import PR",
    prompt: "Read the GitHub pull request I name, including its exact current head SHA and checks. Ask me for any missing RuleRipple field, demand, or minimum value; do not infer them. Then import it with canonical pull-request provenance and evaluate its outcome, rank, and allocation.",
  },
  {
    id: "explain",
    number: "03",
    title: "Explain allocation",
    prompt: "Explain the imported pull request's policy trace, requested and minimum resource amounts, calculated allocation, remaining authorization, and any effect on competing requests. Do not change anything.",
  },
  {
    id: "connect",
    number: "04",
    title: "Authorize merge",
    prompt: "For the eligible allocated request sourced from a GitHub pull request, re-read its exact current head SHA and propose the allow-listed merge action with no more than its remaining resource allocation. If RuleRipple requires human approval, stop before GitHub. If policy automation is enabled, continue only when get_external_execution explicitly authorizes the exact stored invocation.",
  },
  {
    id: "execute",
    number: "05",
    title: "Execute & close",
    prompt: "List external executions. If the exact pull-request merge is authorized, invoke only its stored GitHub MCP tool and arguments, then record GitHub's confirmed success or failure in RuleRipple. Include actual_usage only when a provider explicitly reports metered usage; otherwise leave the authorization committed without inventing consumption.",
  },
] as const satisfies readonly AgentWorkflowStep[];

export function agentWorkflowStepsForWorkspace(ruleCount: number, requestCount: number): readonly AgentWorkflowStep[] {
  if (ruleCount === 0) return agentPolicySetupSteps;
  if (requestCount === 0) return agentRequestSetupSteps;
  return agentWorkflowSteps;
}
