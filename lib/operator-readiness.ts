import type { OperatorConnectionStatus } from "./cloud-api.ts";

export function operatorReadiness(status: OperatorConnectionStatus | null, signedIn: boolean) {
  const batchReady = Boolean(signedIn && status?.operator_access && status.oauth_configured && status.connected);
  const modelReady = Boolean(batchReady && status?.model_configured);
  const reviewReady = Boolean(signedIn && status?.operator_access && status?.model_configured);
  let issue = "";
  if (!signedIn) issue = "Sign in to use connected actions with a saved workspace.";
  else if (!status) issue = "Connection status is not yet available. Check connections below.";
  else {
    const missing: string[] = [];
    if (!status.oauth_configured) missing.push("GitHub OAuth");
    if (status.operator_access_configured === false) missing.push("workspace operator access");
    if (missing.length) issue = `${missing.join(" and ")} must be configured by the site owner before connected requests can run.`;
    else if (!status.operator_access) issue = "This account is not enabled for connected actions. Ask the site owner to grant operator access.";
    else if (!status.connected) issue = status.connection_expired ? "Your GitHub connection expired. Reconnect below to continue." : "Connect your GitHub account below to review requests.";
  }
  const githubLabel = !signedIn ? "Sign in required" : !status ? "Status unavailable" : !status.oauth_configured ? "Site setup required" : status.connected ? "Connected" : status.connection_expired ? "Connection expired" : "Not connected";
  return { batchReady, modelReady, reviewReady, issue, githubLabel };
}
