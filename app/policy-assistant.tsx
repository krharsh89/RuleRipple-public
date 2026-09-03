"use client";

import { useRef, type FormEvent } from "react";
import type { OperatorConnectionStatus, OperatorRunResponse } from "../lib/cloud-api";
import { operatorReadiness } from "../lib/operator-readiness";
import { assistantSuggestion, type WorkspaceTab } from "../lib/workspace-navigation";
import { OperatorReviewPanel } from "./operator-review-panel";

export function AssistantIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3V11.5A7.5 7.5 0 0 1 9.5 4h3A7.5 7.5 0 0 1 20 11.5Z"/><path d="M7 10h8M7 14h5"/></svg>;
}

export function PolicyAssistant({ tab, policyName, configured, signedIn, status, readOnly, onMode, prompt, onPrompt, submittedPrompt, result, stale, busy, error, requiresApproval, onSubmit, onClose, onConnections, onEvidence, onReview }: {
  tab: WorkspaceTab; policyName: string; configured: boolean; signedIn: boolean;
  status: OperatorConnectionStatus | null; readOnly: boolean; onMode: (value: boolean) => void;
  prompt: string; onPrompt: (value: string) => void; submittedPrompt: string;
  result: OperatorRunResponse | null; stale: boolean; busy: boolean; error: string; requiresApproval: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void; onClose?: () => void;
  onConnections: () => void; onEvidence: () => void; onReview: (id: string) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const readiness = operatorReadiness(status, signedIn);
  const ready = configured && (readOnly ? readiness.reviewReady : readiness.modelReady);
  const issue = !configured ? "Define your policy first. The assistant reviews your saved policy and requests." : !signedIn ? "Sign in to use the built-in assistant with a saved workspace." : !status ? "Checking assistant availability. If this continues, check Connections." : !status.operator_access ? "This account needs operator access from the site owner." : !status.model_configured ? "The site owner must configure the server-side model credential." : !readOnly && !readiness.modelReady ? "Connect GitHub in Connections to inspect a source and prepare an action." : "";
  const suggest = (value: string) => { onPrompt(value); input.current?.focus(); };
  return <div className="policy-assistant" aria-label="Policy assistant">
    <header className="assistant-head"><div className="assistant-identity"><span className="assistant-mark"><AssistantIcon /></span><div><h2>Policy assistant</h2><span>Built into RuleRipple</span></div></div>{onClose && <button className="assistant-close" type="button" onClick={onClose} aria-label="Close assistant">×</button>}</header>
    <div className="assistant-context"><span className="eyebrow">Active workspace</span><strong>{configured ? policyName : "Policy setup"}</strong><small>Uses the whole saved portfolio, not just this page.</small></div>
    <div className="assistant-conversation" aria-busy={busy}>
      {!result && !busy && <div className="assistant-welcome"><h3>Understand the next decision.</h3><p>Ask why a request is waiting, inspect your budget, or check a policy threshold.</p><p>The policy engine calculates the results. The assistant explains them.</p></div>}
      {submittedPrompt && (result || busy || error) && <div className="assistant-question"><span className="eyebrow">Your instruction</span><p>{submittedPrompt}</p></div>}
      {busy && <p className="assistant-progress" role="status">Working with the policy engine… You can keep browsing.</p>}
      {result && <article className="assistant-answer" aria-live="polite"><div className="assistant-answer-heading"><strong>{result.readOnly ? "Portfolio reviewed" : result.pendingExecutionId ? "Action prepared" : "Inspection complete"}</strong><span>{result.model}</span></div>
        {stale && <p className="assistant-stale" role="status">Workspace inputs changed since this response. Run a new review for current decisions.</p>}
        {result.portfolioReview && <p className="assistant-evidence-summary">{result.portfolioReview.evaluatedRequests} of {result.portfolioReview.totalRequests} requests evaluated · {result.portfolioReview.latestSavedVersion ?? "No saved version"}</p>}
        <p className="assistant-answer-text">{result.message}</p>
        <button className="button secondary wide" type="button" onClick={onEvidence}>View engine results & tool steps</button>
        {result.pendingExecutionId && <button className="button primary wide" type="button" disabled={busy || stale} onClick={() => onReview(result.pendingExecutionId!)}>Review exact action</button>}
      </article>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <form className="assistant-composer" onSubmit={onSubmit}>
      <label htmlFor="assistant-mode">Assistant mode</label><select id="assistant-mode" value={readOnly ? "review" : "action"} disabled={busy} onChange={(event) => onMode(event.target.value === "review")}><option value="review">Review portfolio · read-only</option><option value="action">GitHub · inspect & prepare action</option></select>
      <p className={`assistant-mode-note ${readOnly ? "" : "can-change"}`}>{readOnly ? "No changes, approvals, or execution." : requiresApproval ? "May import inputs and prepare an action. Stops for human approval." : "May import inputs and execute an exact action if the active policy authorizes it."}</p>
      {issue && <div className="assistant-setup"><p>{issue}</p>{configured && signedIn && <button type="button" onClick={onConnections}>Open Connections</button>}</div>}
      {readOnly && ready && <div className="assistant-suggestions"><button type="button" disabled={busy} onClick={() => suggest(assistantSuggestion(tab))}>Explain current decisions</button><button type="button" disabled={busy} onClick={() => suggest(assistantSuggestion("ledger"))}>Check budget & usage</button></div>}
      <label htmlFor="assistant-instruction">{readOnly ? "Ask about your portfolio" : "Instruction for the connected action"}</label>
      <textarea ref={input} id="assistant-instruction" value={prompt} maxLength={600} rows={3} disabled={!ready || busy} onChange={(event) => onPrompt(event.target.value)} placeholder={readOnly ? "Why is a request waiting for budget?" : "Inspect owner/repository#123 under the active policy…"} aria-describedby="assistant-privacy" />
      <div className="assistant-send-row"><small>{prompt.length}/600</small><button className="button primary" type="submit" disabled={!ready || busy || !prompt.trim()}>{busy ? "Working…" : readOnly ? "Send question" : requiresApproval ? "Inspect & prepare" : "Run with policy authorization"}</button></div>
      <small id="assistant-privacy">Each instruction starts a new review. Your instruction, typed intake, and policy tool results go to OpenAI; the raw pull-request body does not.</small>
    </form>
  </div>;
}

export function AssistantEvidence({ result }: { result: OperatorRunResponse }) {
  return <div className="assistant-evidence"><p className="quiet">Results from the last assistant run · {result.model}</p>{result.portfolioReview && <OperatorReviewPanel review={result.portfolioReview} />}<h3>Tool steps</h3><div className="operator-trace">{result.trace.map((item, index) => <article className={item.status} key={`${item.tool}:${index}`}><span>{item.status === "completed" ? "✓" : "!"}</span><div><strong>{item.title}</strong><p>{item.detail}</p><small>{item.tool}</small></div></article>)}</div></div>;
}
