"use client";

import { FormEvent, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { RequestInbox, IntakeContract } from "./request-inbox-view";
import { AgentConnectionsPanel } from "./agent-connections-panel";
import { AssistantEvidence, AssistantIcon, PolicyAssistant } from "./policy-assistant";
import { navigationGroups, workspaceSections as tabs, type WorkspaceTab as Tab } from "../lib/workspace-navigation";
import { decideInboxBudget, receiveInboxRequests, reviewPolicyBatch } from "../lib/cloud-api";
import { assertInboxUnchanged, decideInboxRequest, receiveAgentRequests, requestInboxView, type AgentRequestInput } from "../lib/request-inbox";
import type { BatchSelection } from "../lib/operator-batch";
import { operatorReadiness } from "../lib/operator-readiness";
import { externalExecutionAccounting, ledgerEventSequence } from "../lib/execution-accounting";
import { executionPolicyIsCurrent, executionRequiresBuiltIn } from "../lib/execution-state";
import {
  allocationStrategyLabels,
  allocateWorkspaceResources,
  approveExternalExecution,
  appendLedgerEvent,
  auditPolicy,
  boundaryPolicy,
  cancelExternalExecution,
  compareSimulationSnapshots,
  createPolicyImpactReport,
  createSnapshot,
  EXTERNAL_ACTIONS,
  formatRule,
  governancePolicy,
  nextId,
  nextRuleId,
  operatorLabel,
  outcomeCounts,
  policyIsValid,
  primaryResource,
  proposeExternalExecution,
  publicReviewerIdentity,
  reconcileResourceUsage,
  recordExternalExecution,
  rejectExternalExecution,
  resourceLedgerState,
  resourceRequiresWholeUnits,
  safeWorkspace,
  scoringPolicy,
  validateRule,
  WORKSPACE_LIMITS,
  type ActivityEvent,
  type AllocationDecision,
  type AllocationStrategy,
  type FieldDefinition,
  type FieldValue,
  type ExternalExecution,
  type Operator,
  type Policy,
  type PolicyAuditIssue,
  type PolicyImpactReport,
  type PolicyRule,
  type RuleKind,
  type TestCase,
  type WorkspaceData,
} from "../lib/domain";
import { policyTemplateWorkspace, simulationPresets, UNCONFIGURED_PRESET_ID, workspaceNeedsConfiguration, type SimulationPreset } from "../lib/presets";
import { useWebMCP, type WebMCPStatus } from "../lib/useWebMCP";
import type { CaseInput, MutationResult } from "../lib/webmcp-tools";
import { latestUndoableEventId, nextActivityId, undoActivityBase, undoPreservesCurrentAudit } from "../lib/history";
import { firestoreAppState, freshAppState, safeLegacyAppState, type AppState } from "../lib/cloud-state";
import { authenticateCloud, CloudApiError, disconnectGitHub, executeWithPolicyOperator, getCloudSession, getOperatorConnectionStatus, loadCloudWorkspace, runPolicyOperator, saveCloudWorkspace, signOutCloud, type AuthenticatedUser, type OperatorConnectionStatus, type OperatorRunResponse } from "../lib/cloud-api";
import { SerializedSaveQueue } from "../lib/save-queue";
import { agentWorkflowStepsForWorkspace, type AgentWorkflowStep } from "../lib/agent-workflow";

type Editor = "definition" | "policy" | "rule" | "case" | "version" | "reconcile" | null;
const STORAGE_KEY = "ruleripple-workspace-v3";
const LEGACY_KEYS = ["ruleripple-workspace-v2", "ruleripple-workspace-v1"];
const tones = ["blue", "violet", "amber", "coral", "teal"];
const assistantIsWide = () => window.matchMedia("(min-width: 1280px)").matches;
const assistantServerWidth = () => false;
function subscribeAssistantViewport(onChange: () => void) {
  const media = window.matchMedia("(min-width: 1280px)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
const copyWorkspace = (value: WorkspaceData): WorkspaceData => structuredClone(value);
type ProposalKind = "policy" | "rule_add" | "rule_update" | "case_upsert";
interface PendingPolicyChange { id: string; kind: ProposalKind; label: string; detail: string; rationale: string; baseline: WorkspaceData; candidate: WorkspaceData; createdAt: string; }
type ExecutionProposalKind = "reserve" | "reconcile";
interface PendingExecutionChange { id: string; kind: ExecutionProposalKind; label: string; detail: string; baseline: WorkspaceData; candidate: WorkspaceData; createdAt: string; }

function displayAmount(value: number, unit: string) {
  if (unit === "USD") return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)} ${unit}`;
}

function countNoun(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatRateWindow(seconds?: number) {
  if (!seconds) return "Not configured";
  if (seconds % 86_400 === 0) return countNoun(seconds / 86_400, "day");
  if (seconds % 3_600 === 0) return countNoun(seconds / 3_600, "hour");
  return countNoun(Math.round(seconds / 60), "minute");
}

function timeAgo(value: string) {
  return new Date(value).toLocaleString();
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; }
    catch { /* Fall through for browser surfaces without clipboard permission. */ }
  }
  const field = document.createElement("textarea");
  field.value = value; field.setAttribute("readonly", ""); field.style.position = "fixed"; field.style.opacity = "0";
  document.body.appendChild(field); field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    field.remove();
  }
  if (!copied) throw new Error("Copy is unavailable.");
}

function policyLeverValue(rule: PolicyRule): number | null {
  if (rule.kind === "score") return rule.points;
  if (rule.kind === "cap") return rule.amount;
  return rule.kind === "threshold" && typeof rule.conditions[0]?.value === "number" ? rule.conditions[0].value : null;
}

function revisePolicyLever(rule: PolicyRule, value: number): PolicyRule {
  if (rule.kind === "score") return { ...rule, points: value };
  if (rule.kind === "cap") return { ...rule, amount: value };
  return { ...rule, conditions: rule.conditions.map((condition, index) => index === 0 ? { ...condition, value } : condition) };
}

function policyLeverLabel(rule: PolicyRule) {
  return rule.kind === "score" ? "Score points" : rule.kind === "cap" ? "Cap amount" : "Threshold value";
}

function workspaceSelectionDefaults(workspace: WorkspaceData) {
  const candidateRule = workspace.rules.find((rule) => rule.enabled && policyLeverValue(rule) !== null) ?? workspace.rules[0];
  const candidateValue = candidateRule ? policyLeverValue(candidateRule) ?? candidateRule.conditions[0]?.value ?? "" : "";
  return { selectedCaseId: workspace.cases[0]?.id ?? "", baselineId: workspace.versions.at(-1)?.id ?? "", candidateRuleId: candidateRule?.id ?? "", candidateValue: String(candidateValue) };
}

function rankingCriterionLabel(item: Policy["ranking"][number], policy: Policy) {
  const label = item.source === "score"
    ? "Computed score"
    : item.source === "field"
      ? policy.fields.find((field) => field.key === item.key)?.label ?? item.key
      : policy.resources.find((resource) => resource.id === item.key)?.label ?? item.key;
  return `${label} · ${item.direction === "desc" ? "high to low" : "low to high"}`;
}

function humanizeOption(value: string) {
  const label = value.replaceAll("_", " ").replaceAll("-", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function ruleOperators(field: FieldDefinition | undefined): Operator[] {
  return field?.type === "enum" || field?.type === "boolean"
    ? ["eq", "neq", "in", "not_in"]
    : ["lt", "lte", "gt", "gte", "eq", "neq", "between"];
}

function friendlyAuthError(error: unknown) {
  const code = error instanceof CloudApiError ? error.code : error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["INVALID_LOGIN_CREDENTIALS", "INVALID_PASSWORD", "EMAIL_NOT_FOUND", "INVALID_SESSION"].some((item) => code.includes(item))) return "Email or password is incorrect.";
  if (code.includes("EMAIL_EXISTS")) return "An account already exists for this email.";
  if (code.includes("WEAK_PASSWORD")) return "Use a password with at least 6 characters.";
  if (code.includes("INVALID_EMAIL")) return "Enter a valid email address.";
  if (code.includes("TOO_MANY") || error instanceof CloudApiError && error.status === 429) return "Too many attempts. Wait a moment and try again.";
  if (code.includes("OPERATION_NOT_ALLOWED")) return "Email/password sign-in is not enabled for this Firebase project.";
  if (code.includes("FIREBASE_NOT_CONFIGURED")) return "The Firebase server configuration is incomplete.";
  if (code.includes("FIREBASE_UNAVAILABLE")) return "Firebase could not be reached securely. Check the connection and try again.";
  return code ? `Authentication could not be completed (${code.toLowerCase().replaceAll("_", "-")}).` : "Authentication could not be completed. Check your connection and try again.";
}

function friendlyOperatorError(error: unknown) {
  const code = error instanceof CloudApiError ? error.code : error instanceof Error ? error.message : "";
  const labels: Record<string, string> = {
    EXECUTION_IN_PROGRESS: "An action is running. Wait before changing the workspace or invoking it again.",
    EXECUTION_RECONCILIATION_REQUIRED: "The outcome is not yet confirmed. Its reservation is retained. Use Reconcile with GitHub; RuleRipple will not send another merge.",
    EXECUTION_POLICY_CHANGED: "The policy or portfolio changed after this action was prepared. Review the current requests again before proceeding.",
    EXECUTION_RESERVATION_CHANGED: "This action no longer has its approved reservation. No new merge was sent. Review its ledger and authorization before continuing.",
    GITHUB_BUDGET_CHANGED: "The configuration budget or base commit changed. Review the PR again before approving it.",
    BATCH_REVIEW_FAILED: "The batch could not be completed. No merge was sent. Check GitHub and the policy, then retry the review.",
    GITHUB_NOT_CONNECTED: "Connect GitHub before asking the policy operator to inspect or execute a pull request.",
    GITHUB_CONNECTION_EXPIRED: "The GitHub connection expired. Reconnect it and try again.",
    GITHUB_PERMISSION_DENIED: "GitHub did not grant permission for this repository or action.",
    GITHUB_TARGET_NOT_FOUND: "The connected GitHub account cannot find that pull request.",
    GITHUB_HEAD_CHANGED: "The pull request changed after authorization. Inspect it again and create a new proposal.",
    GITHUB_POLICY_INTAKE_CHANGED: "The pull request's declared Policy intake changed after inspection. Run the policy operator again to evaluate and authorize the current values.",
    GITHUB_MERGEABILITY_PENDING: "GitHub is still calculating whether this pull request can merge. Wait a moment, then run the policy operator again.",
    GITHUB_PULL_REQUEST_ALREADY_MERGED: "This pull request was merged before RuleRipple could execute the pending approval. No RuleRipple execution receipt was recorded.",
    GITHUB_PULL_REQUEST_NOT_MERGEABLE: "GitHub reports that this pull request cannot currently be merged.",
    GITHUB_PULL_REQUEST_NOT_OPEN: "This pull request is no longer open for execution.",
    GITHUB_MERGE_REJECTED: "GitHub rejected the merge. Resolve its branch protection or mergeability checks, then try again.",
    OPERATOR_MODEL_NOT_CONFIGURED: "The policy operator model connection has not been configured.",
    OPERATOR_ACCESS_DENIED: "The policy operator is not enabled for this workspace owner.",
    INVALID_OPERATOR_REQUEST: "Enter an operator instruction of 600 characters or fewer.",
    OPERATOR_RUN_FAILED: "The model service could not complete this operator run. No external action was executed.",
    EXECUTION_SOURCE_NOT_PINNED: "This older action does not include a pinned source-intake fingerprint. Use its external agent path or inspect the pull request again to create a new operator action.",
    CLOUD_CONFLICT: "The workspace changed in another tab. Reload before running the operator again.",
  };
  return labels[code] ?? (code && !code.includes(" ") ? `The policy operator could not continue (${code.toLowerCase().replaceAll("_", "-")}).` : code || "The policy operator could not continue.");
}

function parseConditionValue(raw: string, field: FieldDefinition | undefined, operator: Operator): FieldValue | FieldValue[] {
  const parts = operator === "between" || operator === "in" || operator === "not_in" ? raw.split(",").map((value) => value.trim()).filter(Boolean) : [raw.trim()];
  const parsed = parts.map((value) => {
    if (field?.type === "boolean") return value === "true";
    if (!field || field.type === "number" || field.type === "integer") { const numeric = Number(value); if (!Number.isFinite(numeric)) throw new Error("Enter a valid numeric comparison value."); return numeric; }
    return value;
  });
  return operator === "between" || operator === "in" || operator === "not_in" ? parsed : parsed[0];
}

export default function Home() {
  const initial = useMemo<AppState>(() => freshAppState(), []); const initialSelections = workspaceSelectionDefaults(initial.data);
  const [app, setApp] = useState<AppState>(initial); const appRef = useRef<AppState>(initial);
  const [hydrated, setHydrated] = useState(false); const [authReady, setAuthReady] = useState(false); const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [guestMode, setGuestMode] = useState(false); const guestModeRef = useRef(false);
  const [authBusy, setAuthBusy] = useState(false); const [authError, setAuthError] = useState(""); const [cloudLoadError, setCloudLoadError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<"idle" | "loading" | "saving" | "saved" | "error">("idle"); const [saveRetry, setSaveRetry] = useState(0);
  const saveQueueRef = useRef(new SerializedSaveQueue<{ app: AppState; serialized: string }>()); const lastSavedRef = useRef("");
  const [activeTab, setActiveTab] = useState<Tab>("canvas"); const [editor, setEditor] = useState<Editor>(null); const [resourceStrategyDraft, setResourceStrategyDraft] = useState<AllocationStrategy | "">(initial.data.presetId === UNCONFIGURED_PRESET_ID ? "" : initial.data.policy.resources[0].strategy); const [editingRule, setEditingRule] = useState<PolicyRule | null>(null); const [ruleFormKind, setRuleFormKind] = useState<RuleKind>("threshold"); const [ruleFormField, setRuleFormField] = useState(""); const [ruleFormOperator, setRuleFormOperator] = useState<Operator>("gte"); const [editingCase, setEditingCase] = useState<TestCase | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PolicyRule | null>(null); const [pendingCaseRemoval, setPendingCaseRemoval] = useState<TestCase | null>(null); const [pendingPolicyChange, setPendingPolicyChange] = useState<PendingPolicyChange | null>(null); const [pendingExecutionChange, setPendingExecutionChange] = useState<PendingExecutionChange | null>(null); const pendingAgentProposalRef = useRef<string | null>(null); const [pendingPreset, setPendingPreset] = useState<SimulationPreset | null>(null); const [libraryOpen, setLibraryOpen] = useState(false); const [leaveConfirmationOpen, setLeaveConfirmationOpen] = useState(false);
  const [externalReviewId, setExternalReviewId] = useState<string | null>(null);
  const [externalRevokeId, setExternalRevokeId] = useState<string | null>(null);
  const [operatorStatus, setOperatorStatus] = useState<OperatorConnectionStatus | null>(null);
  const [connectionRefreshing, setConnectionRefreshing] = useState(false);
  const [operatorPrompt, setOperatorPrompt] = useState("");
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const [assistantError, setAssistantError] = useState("");
  const [assistantPreference, setAssistantOpen] = useState<boolean | null>(null);
  const assistantCompact = !useSyncExternalStore(subscribeAssistantViewport, assistantIsWide, assistantServerWidth);
  const assistantOpen = assistantPreference ?? !assistantCompact;
  const [assistantEvidenceOpen, setAssistantEvidenceOpen] = useState(false);
  const [operatorReadOnly, setOperatorReadOnly] = useState(true);
  const [operatorResult, setOperatorResult] = useState<OperatorRunResponse | null>(null);
  const [operatorBusy, setOperatorBusy] = useState(false);
  const [operatorError, setOperatorError] = useState("");
  const [operatorExecutionBusy, setOperatorExecutionBusy] = useState<string | null>(null);
  const [reconciliationResourceId, setReconciliationResourceId] = useState(initial.data.policy.primaryResourceId);
  const [selectedCaseId, setSelectedCaseId] = useState(initialSelections.selectedCaseId); const [caseFilter, setCaseFilter] = useState<"all" | "eligible" | "boundary" | "review">("all"); const [search, setSearch] = useState("");
  const [baselineId, setBaselineId] = useState(initialSelections.baselineId); const [candidateRuleId, setCandidateRuleId] = useState(initialSelections.candidateRuleId); const [candidateValue, setCandidateValue] = useState(initialSelections.candidateValue);
  const [scenarioDraft, setScenarioDraft] = useState<{ baseKey: string; capacity: string; reserve: string; strategy: AllocationStrategy; windowHours: string; ruleId: string; ruleValue: string } | null>(null); const [announcement, setAnnouncement] = useState("Workspace ready."); const [formError, setFormError] = useState(""); const [storageWarning, setStorageWarning] = useState<string | null>(null); const [sessionWarning, setSessionWarning] = useState<string | null>(null); const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null); const copyResetTimerRef = useRef<number | null>(null);
  const data = app.data; const needsConfiguration = workspaceNeedsConfiguration(data); const isBlankWorkspace = data.presetId === UNCONFIGURED_PRESET_ID; const latestUndoId = latestUndoableEventId(data.activity, app.undo); const latestUndoSnapshot = latestUndoId ? app.undo[latestUndoId] : null; const latestUndoLocked = Boolean(latestUndoSnapshot && (data.ledger.length > latestUndoSnapshot.ledger.length || data.executions.length > latestUndoSnapshot.executions.length)); const mainResource = primaryResource(data.policy); const approverIdentity = user ? "Workspace owner" : guestMode ? "Guest reviewer" : "Human reviewer";
  const scenarioBaseKey = JSON.stringify({ presetId: data.presetId, resource: mainResource, rules: data.rules }); const activeScenarioDraft = scenarioDraft?.baseKey === scenarioBaseKey ? scenarioDraft : null; const scenarioCapacity = activeScenarioDraft?.capacity ?? String(mainResource.capacity); const scenarioReserve = activeScenarioDraft?.reserve ?? String(mainResource.reserve); const scenarioStrategy = activeScenarioDraft?.strategy ?? mainResource.strategy; const scenarioWindowHours = activeScenarioDraft?.windowHours ?? (mainResource.windowSeconds ? String(mainResource.windowSeconds / 3_600) : ""); const scenarioRuleId = activeScenarioDraft?.ruleId ?? ""; const scenarioRuleValue = activeScenarioDraft?.ruleValue ?? "";

  async function hydrateAuthenticatedWorkspace(nextUser: AuthenticatedUser, isActive: () => boolean = () => true) {
    if (!isActive()) return;
    resetTransientWorkspaceUi(); setUser(nextUser); setAuthReady(true); setHydrated(false); setCloudLoadError(null); setStorageWarning(null); lastSavedRef.current = ""; guestModeRef.current = false; setGuestMode(false); setSyncStatus("loading");
    try {
      let restored = await loadCloudWorkspace();
      if (!restored) {
        let initial: AppState | null = null;
        try { const raw = [STORAGE_KEY, ...LEGACY_KEYS].map((key) => localStorage.getItem(key)).find(Boolean); initial = safeLegacyAppState(JSON.parse(raw ?? "null")); } catch { initial = null; }
        restored = initial ?? freshAppState();
        restored = await saveCloudWorkspace(restored, null);
      }
      if (!isActive()) return;
      appRef.current = restored; setApp(restored); alignWorkspaceSelections(restored.data); lastSavedRef.current = JSON.stringify(restored); setHydrated(true); setSyncStatus("saved"); setActiveTab(workspaceNeedsConfiguration(restored.data) ? "canvas" : "inbox");
      try { [STORAGE_KEY, ...LEGACY_KEYS].forEach((key) => localStorage.removeItem(key)); } catch { /* Cloud is authoritative. */ }
    } catch {
      if (!isActive()) return;
      setCloudLoadError("Your cloud workspace could not be loaded safely. Nothing was overwritten."); setSyncStatus("error");
    }
  }

  useEffect(() => {
    let active = true;
    void getCloudSession().then(async (nextUser) => {
      if (!active) return;
      setAuthReady(true);
      if (nextUser) await hydrateAuthenticatedWorkspace(nextUser, () => active);
      else { const fresh = freshAppState(); setUser(null); setActiveTab("canvas"); appRef.current = fresh; setApp(fresh); alignWorkspaceSelections(fresh.data); setSyncStatus("idle"); setHydrated(guestModeRef.current); }
    }).catch(() => { if (active) { setAuthReady(true); setCloudLoadError("The secure session service could not be reached. No workspace data was changed."); setSyncStatus("error"); } });
    return () => { active = false; };
    // Session bootstrap runs once; later sign-ins call the same hydrator explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { if (copyResetTimerRef.current) window.clearTimeout(copyResetTimerRef.current); }, []);
  useEffect(() => {
    if (activeTab !== "inbox" || !hydrated || !user || operatorBusy || operatorExecutionBusy || editor) return;
    let stopped = false, running = false;
    const refresh = async () => {
      if (running || document.visibilityState !== "visible" || JSON.stringify(appRef.current) !== lastSavedRef.current) return;
      const baseline = lastSavedRef.current; running = true;
      try {
        const latest = await loadCloudWorkspace();
        if (!stopped && latest && lastSavedRef.current === baseline && JSON.stringify(appRef.current) === baseline && JSON.stringify(latest) !== baseline) applyOperatorApp(latest);
      } catch { /* Keep the last confirmed portfolio; explicit refresh reports errors. */ }
      finally { running = false; }
    };
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => { stopped = true; window.clearInterval(timer); };
    // Refresh only a clean, visible inbox. Revalidate at completion so a remote
    // arrival cannot overwrite typing, an approval, or a queued local save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, hydrated, user, operatorBusy, operatorExecutionBusy, editor]);
  useEffect(() => {
    if (!hydrated || !user) return;
    let active = true;
    const githubState = new URLSearchParams(window.location.search).get("github");
    void getOperatorConnectionStatus().then((status) => {
      if (!active) return;
      setOperatorStatus(status);
      if (githubState) {
        setActiveTab("operator");
        setAnnouncement(githubState === "connected" ? "GitHub connected to the policy operator." : "GitHub connection could not be completed.");
        setOperatorError(githubState === "connected" ? "" : "GitHub authorization did not complete. Reconnect and try again.");
        window.history.replaceState({}, "", window.location.pathname);
      }
    }).catch(() => { if (active) { setOperatorStatus(null); setOperatorError("Operator connection status is unavailable. Refresh and try again."); } });
    return () => { active = false; };
  }, [hydrated, user]);
  useEffect(() => {
    if (!hydrated || !user) return; const serialized = JSON.stringify(app); if (serialized === lastSavedRef.current && saveRetry === 0) return;
    const payload = { app: firestoreAppState(app), serialized }; const timer = window.setTimeout(() => {
      setSyncStatus("saving");
      void saveQueueRef.current.enqueue(payload, async (queued) => {
        await saveCloudWorkspace(queued.app, lastSavedRef.current);
        lastSavedRef.current = queued.serialized;
      }).then(() => {
        if (JSON.stringify(appRef.current) === payload.serialized) { setSaveRetry(0); setSyncStatus("saved"); setStorageWarning(null); }
      }).catch((error) => { const conflict = error instanceof CloudApiError && error.code === "CLOUD_CONFLICT"; const message = conflict ? "This workspace changed in another tab. Reload the confirmed cloud version before making another change." : "Cloud save failed. Your last confirmed cloud version remains intact."; setSyncStatus("error"); setStorageWarning(message); setAnnouncement(message); });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [app, hydrated, saveRetry, user]);

  function publish(updated: AppState) { appRef.current = updated; setApp(updated); }
  function alignPolicyComparison(workspace: WorkspaceData) {
    const currentCandidate = workspace.rules.find((rule) => rule.id === candidateRuleId && policyLeverValue(rule) !== null);
    const defaults = workspaceSelectionDefaults(workspace), candidate = currentCandidate ?? workspace.rules.find((rule) => rule.id === defaults.candidateRuleId);
    setBaselineId(defaults.baselineId); setCandidateRuleId(candidate?.id ?? ""); setCandidateValue(String(candidate ? policyLeverValue(candidate) ?? candidate.conditions[0]?.value ?? "" : "")); setScenarioDraft(null);
  }
  function alignWorkspaceSelections(workspace: WorkspaceData) {
    const defaults = workspaceSelectionDefaults(workspace); setSelectedCaseId(defaults.selectedCaseId); setBaselineId(defaults.baselineId); setCandidateRuleId(defaults.candidateRuleId); setCandidateValue(defaults.candidateValue); setScenarioDraft(null);
  }
  function resetTransientWorkspaceUi() {
    setSubmittedPrompt(""); setAssistantError(""); setAssistantEvidenceOpen(false); setOperatorReadOnly(true);
    setActiveTab("canvas"); setEditor(null); setEditingRule(null); setRuleFormKind("threshold"); setRuleFormField(""); setRuleFormOperator("gte"); setEditingCase(null); setPendingRemoval(null); setPendingCaseRemoval(null); setPendingPolicyChange(null); setPendingExecutionChange(null); setExternalReviewId(null); setExternalRevokeId(null); setOperatorStatus(null); setOperatorResult(null); setOperatorError(""); setOperatorPrompt(""); setOperatorExecutionBusy(null); pendingAgentProposalRef.current = null; setPendingPreset(null); setLibraryOpen(false); setLeaveConfirmationOpen(false); setFormError(""); setSearch(""); setCaseFilter("all"); setScenarioDraft(null); setStorageWarning(null); setSessionWarning(null);
  }

  function openRuleEditor(rule: PolicyRule | null = null) {
    const field = rule?.conditions[0]?.field ?? data.policy.fields[0]?.key ?? `demand:${data.policy.primaryResourceId}`;
    const definition = data.policy.fields.find((item) => item.key === field);
    const operators = ruleOperators(definition);
    const requestedOperator = rule?.conditions[0]?.operator ?? (definition?.type === "enum" || definition?.type === "boolean" ? "eq" : "gte");
    setEditingRule(rule);
    setRuleFormKind(rule?.kind ?? "threshold");
    setRuleFormField(field);
    setRuleFormOperator(operators.includes(requestedOperator) ? requestedOperator : operators[0]);
    setFormError("");
    setEditor("rule");
  }
  function openCaseEditor(item: TestCase | null = null) {
    setEditingCase(item);
    setFormError("");
    setEditor("case");
  }
  function openResourceEditor(nextEditor: "definition" | "policy", strategy?: AllocationStrategy) {
    setResourceStrategyDraft(strategy ?? (isBlankWorkspace ? "" : mainResource.strategy));
    setFormError("");
    setEditor(nextEditor);
  }
  function commit(mutate: (draft: WorkspaceData) => void, actor: ActivityEvent["actor"], action: string, detail: string, undoable = true) {
    if (operatorBusy || operatorExecutionBusy) throw new Error("Wait for the current operator operation to finish before changing the workspace.");
    const current = appRef.current; const before = copyWorkspace(current.data); const next = copyWorkspace(current.data); mutate(next);
    assertInboxUnchanged(before, next);
    const inputComparison = compareSimulationSnapshots(createSnapshot(before.policy, before.rules, before.cases), createSnapshot(next.policy, next.rules, next.cases));
    const simulationInputsChanged = inputComparison.policyChanged || inputComparison.changedRules.length > 0 || inputComparison.changedRequests.length > 0;
    if (simulationInputsChanged && next.impactReports.length === before.impactReports.length) {
      if (next.versions.length >= WORKSPACE_LIMITS.versions || next.impactReports.length >= WORKSPACE_LIMITS.impactReports) throw new Error("Version or impact-report storage limit reached. Export the audit file before starting a new workspace.");
      const createdAt = new Date().toISOString(), candidateVersionId = nextId("V", next.versions), reportId = nextId("IR", next.impactReports), snapshot = createSnapshot(next.policy, next.rules, next.cases);
      next.versions.push({ id: candidateVersionId, label: action, rationale: detail || action, createdAt, snapshot });
      const sourceActor = actor === "engine" ? "human" : actor;
      next.impactReports.push(createPolicyImpactReport({ id: reportId, label: action, rationale: detail || action, actor: sourceActor, approvedBy: sourceActor === "human" ? approverIdentity : null, baseline: createSnapshot(before.policy, before.rules, before.cases), candidate: snapshot, baselineVersionId: before.versions.at(-1)?.id ?? null, candidateVersionId, createdAt }));
    }
    if (!safeWorkspace(next)) throw new Error("The change would create an invalid workspace and was rejected.");
    const event: ActivityEvent = { id: nextActivityId(next.activity, appRef.current.undo), actor, action, detail, createdAt: new Date().toISOString(), undoable }; next.activity = [event, ...next.activity].slice(0, WORKSPACE_LIMITS.activity);
    let undo = current.undo; if (undoable) { undo = { ...undo, [event.id]: before }; const retained = Object.keys(undo).slice(-WORKSPACE_LIMITS.undoSnapshots); undo = Object.fromEntries(retained.map((id) => [id, undo[id]])); }
    publish({ data: next, undo }); if (simulationInputsChanged) alignPolicyComparison(next); setAnnouncement(action);
  }
  function replaceWorkspace(workspace: WorkspaceData, actor: ActivityEvent["actor"], action: string, detail: string) {
    const current = appRef.current; const next = copyWorkspace(workspace); if (!safeWorkspace(next)) throw new Error("The selected simulation is invalid and was not loaded."); const event: ActivityEvent = { id: nextActivityId(next.activity, current.undo, current.data.activity), actor, action, detail, createdAt: new Date().toISOString(), undoable: true, changeKind: "workspace_replace" }; next.activity = [event, ...next.activity].slice(0, WORKSPACE_LIMITS.activity);
    const undo = { ...current.undo, [event.id]: copyWorkspace(current.data) }; const retained = Object.keys(undo).slice(-WORKSPACE_LIMITS.undoSnapshots); publish({ data: next, undo: Object.fromEntries(retained.map((id) => [id, undo[id]])) }); alignWorkspaceSelections(next); setAnnouncement(action);
  }
  function installPreset(preset: SimulationPreset) {
    replaceWorkspace(policyTemplateWorkspace(preset), "human", `${preset.title} schema selected`, "Installed schema structure only; no capacity, reserve, rate window, rules, requests, or assignments were supplied.");
    setPendingPreset(null); setLibraryOpen(false); setActiveTab("canvas"); openResourceEditor("definition", primaryResource(preset.workspace.policy).strategy);
  }
  function choosePreset(preset: SimulationPreset) {
    const hasLiveInputs = data.rules.length > 0 || data.cases.length > 0 || data.ledger.length > 0 || data.executions.length > 0;
    if (needsConfiguration && !hasLiveInputs) { installPreset(preset); return; }
    setLibraryOpen(false); setPendingPreset(preset);
  }
  function stageOrApplyAgentChange<T>(kind: ProposalKind, label: string, detail: string, mutate: (draft: WorkspaceData) => T): MutationResult<T> {
    if (pendingAgentProposalRef.current || pendingPolicyChange || pendingExecutionChange || appRef.current.data.executions.some((item) => item.status === "pending_approval")) throw new Error("Another agent proposal is already waiting for human review.");
    const baseline = copyWorkspace(appRef.current.data), candidate = copyWorkspace(appRef.current.data); const value = mutate(candidate);
    if (!safeWorkspace(candidate)) throw new Error("The proposed change would create an invalid workspace and was rejected.");
    if (governancePolicy(baseline.policy).requireApproval) {
      const proposalId = `P-${kind}-${baseline.activity.length + 1}-${baseline.versions.length + 1}`;
      pendingAgentProposalRef.current = proposalId;
      setPendingPolicyChange({ id: proposalId, kind, label, detail, rationale: detail, baseline, candidate, createdAt: new Date().toISOString() });
      setFormError(""); setActiveTab("impact"); setAnnouncement(`${label} is waiting for human approval.`);
      return { value, status: "pending_human_confirmation", proposalId };
    }
    commit((draft) => Object.assign(draft, candidate), "agent", label, detail);
    return { value, status: "applied" };
  }
  function approvePendingPolicyProposal() {
    if (!pendingPolicyChange) return;
    if (JSON.stringify(appRef.current.data) !== JSON.stringify(pendingPolicyChange.baseline)) { setFormError("The active workspace changed after this proposal was created. Reject it and ask the agent to propose again."); return; }
    try { applyCandidateWithImpact(pendingPolicyChange.candidate, `${pendingPolicyChange.label} approved`, `Approved agent proposal ${pendingPolicyChange.id}. ${pendingPolicyChange.rationale}`, "agent"); pendingAgentProposalRef.current = null; setPendingPolicyChange(null); setActiveTab("versions"); setFormError(""); }
    catch (error) { setFormError(error instanceof Error ? error.message : "The proposal could not be approved."); }
  }
  function rejectPendingPolicyProposal() { if (!pendingPolicyChange) return; const label = pendingPolicyChange.label; pendingAgentProposalRef.current = null; setPendingPolicyChange(null); commit(() => undefined, "human", `${label} rejected`, "Rejected an agent-proposed policy change after reviewing its simulated impact.", false); }
  function stageAgentExecution<T>(kind: ExecutionProposalKind, label: string, detail: string, mutate: (draft: WorkspaceData) => T): MutationResult<T> {
    if (pendingAgentProposalRef.current || pendingPolicyChange || pendingExecutionChange || appRef.current.data.executions.some((item) => item.status === "pending_approval")) throw new Error("Another agent proposal is already waiting for human review.");
    const baseline = copyWorkspace(appRef.current.data), candidate = copyWorkspace(appRef.current.data); const value = mutate(candidate);
    if (!safeWorkspace(candidate)) throw new Error("The proposed execution would create an invalid workspace and was rejected.");
    const proposalId = `PX-${kind}-${baseline.activity.length + 1}-${baseline.ledger.length + 1}`;
    pendingAgentProposalRef.current = proposalId;
    setPendingExecutionChange({ id: proposalId, kind, label, detail, baseline, candidate, createdAt: new Date().toISOString() });
    setEditor(null); setPendingRemoval(null); setFormError(""); setActiveTab("ledger"); setAnnouncement(`${label} is waiting for human approval.`);
    return { value, status: "pending_human_confirmation", proposalId };
  }
  function approvePendingExecutionProposal() {
    if (!pendingExecutionChange) return;
    if (JSON.stringify(appRef.current.data) !== JSON.stringify(pendingExecutionChange.baseline)) { setFormError("The active workspace changed after this execution was proposed. Reject it and ask the agent to propose again."); return; }
    const proposal = pendingExecutionChange;
    try {
      commit((draft) => Object.assign(draft, proposal.candidate), "human", `${proposal.label} approved`, `Approved agent execution ${proposal.id}. ${proposal.detail}`, false);
      pendingAgentProposalRef.current = null; setPendingExecutionChange(null); setActiveTab("ledger"); setFormError("");
    } catch (error) { setFormError(error instanceof Error ? error.message : "The execution proposal could not be approved."); }
  }
  function rejectPendingExecutionProposal() { if (!pendingExecutionChange) return; const label = pendingExecutionChange.label; pendingAgentProposalRef.current = null; setPendingExecutionChange(null); commit(() => undefined, "human", `${label} rejected`, "Rejected an agent-proposed resource execution without changing the ledger.", false); }
  function approvePendingExternalExecution(execution: ExternalExecution) {
    try { commit((draft) => Object.assign(draft, approveExternalExecution(draft, execution.id, approverIdentity)), "human", `${EXTERNAL_ACTIONS[execution.actionId].label} approved`, `Approved ${execution.id}; ${execution.authorizedAmount} ${data.policy.resources.find((item) => item.id === execution.resourceId)?.unit ?? "units"} reserved for ${execution.tool}.`, false); setExternalReviewId(null); setActiveTab("executions"); setFormError(""); }
    catch (error) { setFormError(error instanceof Error ? error.message : "The external action could not be approved."); }
  }
  function rejectPendingExternalExecution(execution: ExternalExecution) {
    try { commit((draft) => Object.assign(draft, rejectExternalExecution(draft, execution.id)), "human", `${EXTERNAL_ACTIONS[execution.actionId].label} rejected`, `Rejected ${execution.id} without invoking GitHub or moving resource capacity.`, false); setExternalReviewId(null); setActiveTab("executions"); setFormError(""); }
    catch (error) { setFormError(error instanceof Error ? error.message : "The external action could not be rejected."); }
  }
  function revokeApprovedExternalExecution(execution: ExternalExecution) {
    try { commit((draft) => Object.assign(draft, cancelExternalExecution(draft, execution.id, approverIdentity)), "human", `${EXTERNAL_ACTIONS[execution.actionId].label} approval revoked`, `Revoked ${execution.id} before a result was recorded and released ${execution.authorizedAmount} ${data.policy.resources.find((item) => item.id === execution.resourceId)?.unit ?? "units"}.`, false); setExternalRevokeId(null); setActiveTab("executions"); setFormError(""); }
    catch (error) { setFormError(error instanceof Error ? error.message : "The external approval could not be revoked."); }
  }
  function applyCandidateWithImpact(candidateInput: WorkspaceData, label: string, rationale: string, actor: PolicyImpactReport["actor"] = "human") {
    const baseline = copyWorkspace(appRef.current.data), candidate = copyWorkspace(candidateInput);
    if (candidate.versions.length >= WORKSPACE_LIMITS.versions || candidate.impactReports.length >= WORKSPACE_LIMITS.impactReports) throw new Error("Version or impact-report storage limit reached. Export the audit file before starting a new workspace.");
    const createdAt = new Date().toISOString(), candidateVersionId = nextId("V", candidate.versions), reportId = nextId("IR", candidate.impactReports), snapshot = createSnapshot(candidate.policy, candidate.rules, candidate.cases);
    candidate.versions.push({ id: candidateVersionId, label, rationale, createdAt, snapshot });
    candidate.impactReports.push(createPolicyImpactReport({ id: reportId, label, rationale, actor, approvedBy: approverIdentity, baseline: createSnapshot(baseline.policy, baseline.rules, baseline.cases), candidate: snapshot, baselineVersionId: baseline.versions.at(-1)?.id ?? null, candidateVersionId, createdAt }));
    commit((draft) => Object.assign(draft, candidate), "human", label, `${rationale} Impact report ${reportId} recorded.`);
    return { candidateVersionId, reportId };
  }

  const portfolio = useMemo(() => allocateWorkspaceResources(data), [data]); const counts = useMemo(() => outcomeCounts(portfolio.evaluations), [portfolio.evaluations]);
  const activeBoundaryPolicy = boundaryPolicy(data.policy), activeScoringPolicy = scoringPolicy(data.policy), activeGovernancePolicy = governancePolicy(data.policy); const policyAudit = useMemo(() => auditPolicy(data.policy, data.rules, data.cases), [data.policy, data.rules, data.cases]);
  const scenarioRuleLevers = useMemo(() => data.rules.filter((rule) => rule.enabled && policyLeverValue(rule) !== null), [data.rules]); const selectedScenarioRule = scenarioRuleLevers.find((rule) => rule.id === scenarioRuleId); const scenarioRuleNumber = Number(scenarioRuleValue);
  const scenarioCapacityValue = Number(scenarioCapacity), scenarioReserveValue = Number(scenarioReserve), scenarioWindowHoursValue = Number(scenarioWindowHours); const scenarioUsesWholeUnits = resourceRequiresWholeUnits({ ...mainResource, strategy: scenarioStrategy, divisible: scenarioStrategy === "slot" || scenarioStrategy === "rate_limit" ? false : mainResource.divisible }); const scenarioWindowValid = scenarioStrategy !== "rate_limit" || scenarioWindowHours.trim() !== "" && Number.isFinite(scenarioWindowHoursValue) && scenarioWindowHoursValue > 0 && scenarioWindowHoursValue <= 8_760; const resourceScenarioValid = scenarioCapacity.trim() !== "" && scenarioReserve.trim() !== "" && Number.isFinite(scenarioCapacityValue) && Number.isFinite(scenarioReserveValue) && scenarioCapacityValue >= 0 && scenarioCapacityValue <= 100_000_000 && scenarioReserveValue >= 0 && scenarioReserveValue <= scenarioCapacityValue && (!scenarioUsesWholeUnits || Number.isInteger(scenarioCapacityValue) && Number.isInteger(scenarioReserveValue)) && scenarioWindowValid;
  const scenarioRuleCandidate = selectedScenarioRule && scenarioRuleValue.trim() !== "" && Number.isFinite(scenarioRuleNumber) ? revisePolicyLever(selectedScenarioRule, scenarioRuleNumber) : null; const scenarioRuleValid = !scenarioRuleId || Boolean(scenarioRuleCandidate && validateRule(scenarioRuleCandidate, data.policy).length === 0);
  const scenarioRules = scenarioRuleCandidate ? data.rules.map((rule) => rule.id === scenarioRuleCandidate.id ? scenarioRuleCandidate : rule) : data.rules; const scenarioRuleChanged = Boolean(selectedScenarioRule && scenarioRuleCandidate && policyLeverValue(selectedScenarioRule) !== policyLeverValue(scenarioRuleCandidate));
  const scenarioPolicy = { ...data.policy, resources: data.policy.resources.map((resource) => { if (resource.id !== data.policy.primaryResourceId || !resourceScenarioValid) return resource; const next = { ...resource, capacity: scenarioCapacityValue, reserve: scenarioReserveValue, strategy: scenarioStrategy, divisible: scenarioStrategy === "slot" || scenarioStrategy === "rate_limit" ? false : resource.divisible }; if (scenarioStrategy === "rate_limit") next.windowSeconds = scenarioWindowHoursValue * 3_600; else delete next.windowSeconds; return next; }) };
  const scenarioValid = resourceScenarioValid && scenarioRuleValid && policyIsValid(scenarioPolicy); const scenarioAudit = auditPolicy(scenarioPolicy, scenarioRules, data.cases), scenarioBlockingIssues = scenarioAudit.filter((issue) => issue.severity === "error"); const scenarioChanged = scenarioValid ? scenarioCapacityValue !== mainResource.capacity || scenarioReserveValue !== mainResource.reserve || scenarioStrategy !== mainResource.strategy || scenarioStrategy === "rate_limit" && scenarioWindowHoursValue * 3_600 !== mainResource.windowSeconds || scenarioRuleChanged : Boolean(activeScenarioDraft);
  const scenarioPortfolio = allocateWorkspaceResources({ ...data, rules: scenarioRules, policy: scenarioPolicy }); const scenarioSummary = scenarioPortfolio.resources.find((item) => item.resourceId === mainResource.id)!;
  const scenarioPartialCount = scenarioPortfolio.allocations.filter((item) => item.resources[mainResource.id]?.status === "partial").length; const scenarioGapCount = scenarioPortfolio.allocations.filter((item) => item.rank && item.resources[mainResource.id]?.status === "unallocated").length; const scenarioDemandGap = Math.max(0, scenarioSummary.requested - scenarioSummary.allocated);
  const currentAllocations = new Map(portfolio.allocations.map((item) => [item.caseId, item])); const currentEvaluations = new Map(portfolio.evaluations.map((item) => [item.caseId, item])); const scenarioEvaluations = new Map(scenarioPortfolio.evaluations.map((item) => [item.caseId, item]));
  const scenarioDeltas = scenarioPortfolio.allocations.map((after) => { const before = currentAllocations.get(after.caseId); const beforeEvaluation = currentEvaluations.get(after.caseId), afterEvaluation = scenarioEvaluations.get(after.caseId); const beforeAmount = before?.resources[mainResource.id]?.allocated ?? 0, afterAmount = after.resources[mainResource.id]?.allocated ?? 0; return { caseId: after.caseId, beforeAmount, afterAmount, delta: afterAmount - beforeAmount, beforeRank: before?.rank ?? null, afterRank: after.rank, beforeOutcome: beforeEvaluation?.outcome, afterOutcome: afterEvaluation?.outcome, outcomeChanged: beforeEvaluation?.outcome !== afterEvaluation?.outcome, rankChanged: before?.rank !== after.rank }; }).filter((item) => Math.abs(item.delta) > 0.000001 || item.outcomeChanged || item.rankChanged).sort((left, right) => Number(right.outcomeChanged) - Number(left.outcomeChanged) || Math.abs(right.delta) - Math.abs(left.delta));
  const scenarioOutcomeChanges = scenarioDeltas.filter((item) => item.outcomeChanged).length, scenarioRankChanges = scenarioDeltas.filter((item) => item.rankChanged).length;
  const orderedRules = useMemo(() => [...data.rules].sort((left, right) => Number(right.enabled) - Number(left.enabled) || right.priority - left.priority || left.id.localeCompare(right.id)), [data.rules]);
  const evaluationById = useMemo(() => new Map(portfolio.evaluations.map((item) => [item.caseId, item])), [portfolio.evaluations]); const allocationById = useMemo(() => new Map(portfolio.allocations.map((item) => [item.caseId, item])), [portfolio.allocations]);
  const selectedCase = data.cases.find((item) => item.id === selectedCaseId) ?? data.cases[0]; const selectedEvaluation = selectedCase ? evaluationById.get(selectedCase.id) : undefined; const selectedAllocation = selectedCase ? allocationById.get(selectedCase.id) : undefined;
  const filteredCases = data.cases.filter((item) => { const outcome = evaluationById.get(item.id)?.outcome; return (caseFilter === "all" || outcome === caseFilter) && item.name.toLowerCase().includes(search.toLowerCase()); });
  const selectedCaseIsVisible = Boolean(selectedCase && filteredCases.some((item) => item.id === selectedCase.id));
  const comparisonRuleLevers = data.rules.filter((rule) => policyLeverValue(rule) !== null); const candidateRule = comparisonRuleLevers.find((rule) => rule.id === candidateRuleId) ?? comparisonRuleLevers[0]; const effectiveCandidateRuleId = candidateRule?.id ?? ""; const candidateNumber = Number(candidateValue); const candidateParseError = candidateValue.trim() === "" || !Number.isFinite(candidateNumber);
  const selectedRuleField = data.policy.fields.find((field) => field.key === ruleFormField);
  const selectedRuleResource = data.policy.resources.find((resource) => ruleFormField === `demand:${resource.id}`);
  const selectedRuleValueHint = selectedRuleField && (selectedRuleField.type === "number" || selectedRuleField.type === "integer")
    ? selectedRuleField.min !== undefined || selectedRuleField.max !== undefined ? `Allowed range: ${selectedRuleField.min ?? "any"}–${selectedRuleField.max ?? "any"}${selectedRuleField.unit ? ` ${selectedRuleField.unit}` : ""}.` : selectedRuleField.unit ? `Enter a value in ${selectedRuleField.unit}.` : ""
    : selectedRuleResource ? `Enter a non-negative amount in ${selectedRuleResource.unit}.` : "";
  const candidateDraft = candidateRule && !candidateParseError ? revisePolicyLever(candidateRule, candidateNumber) : null; const candidateRules = data.rules.map((rule) => rule.id === effectiveCandidateRuleId && candidateDraft ? candidateDraft : rule);
  const candidateAudit = auditPolicy(data.policy, candidateRules, data.cases), candidateIsValid = !candidateParseError && candidateAudit.every((issue) => issue.severity !== "error") && Boolean(candidateDraft && validateRule(candidateDraft, data.policy).length === 0); const candidateChangesCurrent = Boolean(candidateRule && candidateDraft && policyLeverValue(candidateRule) !== policyLeverValue(candidateDraft));
  const baseline = data.versions.find((version) => version.id === baselineId) ?? data.versions.at(-1); const candidateSnapshot = createSnapshot(data.policy, candidateRules, data.cases); const comparison = compareSimulationSnapshots(baseline?.snapshot ?? candidateSnapshot, candidateSnapshot); const changedInputCount = comparison.changedRules.length + comparison.changedRequests.length + Number(comparison.policyChanged);

  const webMCPStatus = useWebMCP({ getData: () => appRef.current.data, actions: {
    submitBudgetRequests: submitIncomingRequests,
    createPolicy: (policy, resetWorkspace) => stageOrApplyAgentChange("policy", resetWorkspace ? "Policy schema replacement" : "Policy details update", resetWorkspace ? `Install ${policy.name} with reset requests, ledger, and external actions while preserving policy versions.` : `Set the active policy to ${policy.name}.`, (draft) => { draft.policy = policy; draft.presetId = "custom"; if (resetWorkspace) { draft.rules = []; draft.cases = []; draft.ledger = []; draft.executions = []; } return policy; }),
    addRule: (input) => { const current = appRef.current.data; if (current.rules.length >= WORKSPACE_LIMITS.rules) throw new Error("Rule limit reached."); const rule: PolicyRule = { ...input, id: nextRuleId(current), enabled: true }; return stageOrApplyAgentChange("rule_add", `Add ${rule.label}`, `Add ${rule.id} through WebMCP.`, (draft) => { draft.rules.push(rule); return rule; }); },
    updateRule: (id, patch) => { const existing = appRef.current.data.rules.find((rule) => rule.id === id); if (!existing) return null; const updated = { ...existing, ...patch }; return stageOrApplyAgentChange("rule_update", `Update ${existing.label}`, `Change ${id} through WebMCP.`, (draft) => { draft.rules = draft.rules.map((rule) => rule.id === id ? updated : rule); return updated; }); },
    requestRemoveRule: (id) => { const rule = appRef.current.data.rules.find((item) => item.id === id) ?? null; if (rule) { setEditor(null); setPendingRemoval(rule); setAnnouncement(`${rule.label} is waiting for human confirmation.`); } return rule; },
    upsertCases: (incoming: CaseInput[]) => {
      const current = appRef.current.data; let nextNumber = Math.max(0, ...current.cases.map((item) => Number(item.id.replace(/\D/g, "")) || 0));
      const saved = incoming.map((item) => { const existing = item.id ? current.cases.find((entry) => entry.id.toLowerCase() === item.id?.toLowerCase()) : current.cases.find((entry) => entry.name.toLowerCase() === item.name.toLowerCase()); return { ...item, id: existing?.id ?? item.id ?? `C-${String(++nextNumber).padStart(2, "0")}`, actualUsage: existing?.actualUsage ?? {}, ...(item.source ?? existing?.source ? { source: item.source ?? existing?.source } : {}) }; });
      return stageOrApplyAgentChange("case_upsert", `Add or update ${countNoun(saved.length, "request")}`, "Apply the supplied request inputs through WebMCP.", (draft) => { for (const item of saved) { const index = draft.cases.findIndex((entry) => entry.id === item.id); if (index >= 0) draft.cases[index] = item; else draft.cases.push(item); } return saved; });
    },
    saveVersion: (label, rationale) => { const current = appRef.current.data; const id = nextId("V", current.versions); commit((draft) => { draft.versions.push({ id, label, rationale, createdAt: new Date().toISOString(), snapshot: createSnapshot(draft.policy, draft.rules, draft.cases) }); }, "agent", `${label} saved`, rationale, false); return id; },
    appendLedger: (input) => { const checked = appendLedgerEvent(appRef.current.data, { ...input, actor: "agent" }); if (checked.duplicate) return { value: checked.event, status: "applied" }; const unit = appRef.current.data.policy.resources.find((item) => item.id === input.resourceId)?.unit ?? "units"; return stageAgentExecution("reserve", "Resource reservation", `${displayAmount(input.amount, unit)} for ${input.requestId} in ${input.resourceId}.`, (draft) => { const result = appendLedgerEvent(draft, { ...input, actor: "agent" }); Object.assign(draft, result.workspace); return result.event; }); },
    reconcileUsage: (requestId, resourceId, actualUsage, idempotencyKey) => { const checked = reconcileResourceUsage(appRef.current.data, requestId, resourceId, actualUsage, "agent", idempotencyKey); const value = { requestId, resourceId, actualUsage }; if (checked === appRef.current.data) return { value, status: "applied" }; const unit = appRef.current.data.policy.resources.find((item) => item.id === resourceId)?.unit ?? "units"; return stageAgentExecution("reconcile", "Usage reconciliation", `${requestId} reports ${displayAmount(actualUsage, unit)} used from ${resourceId}; unused capacity will be released.`, (draft) => { Object.assign(draft, reconcileResourceUsage(draft, requestId, resourceId, actualUsage, "agent", idempotencyKey)); return value; }); },
    proposeExternalExecution: (input) => {
      const result = proposeExternalExecution(appRef.current.data, input);
      if (!result.duplicate) {
        const unit = appRef.current.data.policy.resources.find((item) => item.id === result.execution.resourceId)?.unit ?? "units";
        const detail = result.execution.authorizationMode === "human_approval"
          ? `${result.execution.id} requests the GitHub MCP tool ${result.execution.tool}; the active policy requires review of the exact arguments and resource authorization.`
          : `${result.execution.id} was authorized automatically by ${result.execution.policyVersionId}; the exact arguments are pinned and ${result.execution.authorizedAmount} ${unit} reserved.`;
        commit((draft) => Object.assign(draft, result.workspace), result.execution.authorizationMode === "human_approval" ? "agent" : "engine", result.execution.authorizationMode === "human_approval" ? "External action proposed" : "External action policy-authorized", detail, false);
      }
      setExternalReviewId(result.execution.status === "pending_approval" ? result.execution.id : null); setActiveTab("executions"); setFormError("");
      return { value: result.execution, status: result.execution.status === "pending_approval" ? "pending_human_confirmation" : "applied", proposalId: result.execution.id };
    },
    recordExternalExecution: (executionId, receipt) => {
      const next = recordExternalExecution(appRef.current.data, executionId, receipt); const execution = next.executions.find((item) => item.id === executionId)!;
      const unit = next.policy.resources.find((item) => item.id === execution.resourceId)?.unit ?? "units";
      if (next !== appRef.current.data) commit((draft) => Object.assign(draft, next), "agent", `External action ${receipt.status}`, `${execution.id} recorded ${receipt.externalReference}: ${receipt.summary}${receipt.actualUsage === undefined ? "" : ` Provider reported ${displayAmount(receipt.actualUsage, unit)} used.`}`, false);
      setActiveTab("executions"); setFormError(""); return execution;
    },
  } }, Boolean((user || guestMode) && hydrated));

  const statusCopy = { checking: "WebMCP checking", ready: "WebMCP ready", unavailable: "WebMCP unavailable", blocked: "WebMCP top-level only", error: "WebMCP error", "signed-out": "Sign in for WebMCP" }[webMCPStatus];
  function updateScenario(patch: Partial<Omit<NonNullable<typeof scenarioDraft>, "baseKey">>) { setScenarioDraft({ baseKey: scenarioBaseKey, capacity: scenarioCapacity, reserve: scenarioReserve, strategy: scenarioStrategy, windowHours: scenarioWindowHours, ruleId: scenarioRuleId, ruleValue: scenarioRuleValue, ...patch }); }
  function updateScenarioCapacity(value: string) { updateScenario({ capacity: value }); }
  function updateScenarioReserve(value: string) { updateScenario({ reserve: value }); }
  function updateScenarioRule(ruleId: string) { const rule = scenarioRuleLevers.find((item) => item.id === ruleId); updateScenario({ ruleId, ruleValue: rule ? String(policyLeverValue(rule)) : "" }); }
  function resetScenario() { setScenarioDraft(null); setAnnouncement("Scenario reset to the active policy."); }
  function applyScenario() { if (!scenarioValid || !scenarioChanged || scenarioBlockingIssues.length) return; const changes = [`${mainResource.label}: ${scenarioCapacityValue} capacity, ${scenarioReserveValue} protected, ${allocationStrategyLabels[scenarioStrategy]}${scenarioStrategy === "rate_limit" ? `, ${formatRateWindow(scenarioWindowHoursValue * 3_600)} window` : ""}`]; if (scenarioRuleChanged && scenarioRuleCandidate) changes.push(`${scenarioRuleCandidate.id}: ${policyLeverLabel(scenarioRuleCandidate).toLowerCase()} ${scenarioRuleNumber}`); const candidate = copyWorkspace(data); candidate.policy = structuredClone(scenarioPolicy); candidate.rules = structuredClone(scenarioRules); try { applyCandidateWithImpact(candidate, "Policy scenario approved", changes.join(" · ")); resetScenario(); setActiveTab("versions"); } catch (error) { setFormError(error instanceof Error ? error.message : "The scenario could not be applied."); } }
  function applyComparedRevision() { try { commit((draft) => { draft.rules = structuredClone(candidateRules); }, "human", "Candidate revision applied", `Updated ${effectiveCandidateRuleId}.`); setFormError(""); } catch (error) { setFormError(error instanceof Error ? error.message : "The candidate revision could not be applied."); } }
  function exportAuditFile() { const payload = JSON.stringify({ format: "ruleripple-audit-export", formatVersion: 1, exportedAt: new Date().toISOString(), ...data, impactReports: data.impactReports.map((report) => ({ ...report, approvedBy: publicReviewerIdentity(report.approvedBy) })), executions: data.executions.map((execution) => ({ ...execution, approvedBy: publicReviewerIdentity(execution.approvedBy), cancelledBy: publicReviewerIdentity(execution.cancelledBy) })), portfolio }, null, 2); const url = URL.createObjectURL(new Blob([payload], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = `ruleripple-audit-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url); setAnnouncement("Audit file exported."); }
  function shareImpactReport(report: PolicyImpactReport) { const publicReport = { ...report, approvedBy: publicReviewerIdentity(report.approvedBy) }; const url = URL.createObjectURL(new Blob([JSON.stringify(publicReport, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = `ruleripple-impact-${report.id.toLowerCase()}.json`; link.click(); URL.revokeObjectURL(url); setAnnouncement(`${report.id} exported.`); }
  function confirmRemoval() { if (!pendingRemoval) return; const rule = pendingRemoval; try { commit((draft) => { draft.rules = draft.rules.filter((item) => item.id !== rule.id); }, "human", `${rule.label} removed`, `Confirmed removal of ${rule.id}.`); setPendingRemoval(null); setFormError(""); } catch (error) { setFormError(error instanceof Error ? error.message : "The rule could not be removed."); } }
  function undo(event: ActivityEvent) {
    const current = appRef.current;
    if (latestUndoableEventId(current.data.activity, current.undo) !== event.id) { setAnnouncement("Undo the newest reversible change first."); return; }
    const snapshot = current.undo[event.id]; if (!snapshot) return;
    if (current.data.ledger.length > snapshot.ledger.length || current.data.executions.length > snapshot.executions.length || JSON.stringify(current.data.inbox ?? []) !== JSON.stringify(snapshot.inbox ?? [])) { setAnnouncement("Undo cannot discard received requests or authorization history. Create a new policy revision instead."); return; }
    const restored = copyWorkspace(snapshot);
    const comparison = compareSimulationSnapshots(createSnapshot(current.data.policy, current.data.rules, current.data.cases), createSnapshot(restored.policy, restored.rules, restored.cases));
    if (undoPreservesCurrentAudit(event) && (comparison.policyChanged || comparison.changedRules.length || comparison.changedRequests.length)) {
      restored.versions = structuredClone(current.data.versions); restored.impactReports = structuredClone(current.data.impactReports);
      if (restored.versions.length >= WORKSPACE_LIMITS.versions || restored.impactReports.length >= WORKSPACE_LIMITS.impactReports) { setAnnouncement("Undo needs space for its audit record. Export the audit file before starting a new workspace."); return; }
      const createdAt = new Date().toISOString(), candidateVersionId = nextId("V", restored.versions), reportId = nextId("IR", restored.impactReports), candidate = createSnapshot(restored.policy, restored.rules, restored.cases);
      const label = `Undo: ${event.action}`;
      restored.versions.push({ id: candidateVersionId, label, rationale: "Human-approved rollback to the preceding workspace state.", createdAt, snapshot: candidate });
      restored.impactReports.push(createPolicyImpactReport({ id: reportId, label, rationale: "Human-approved rollback to the preceding workspace state.", actor: "human", approvedBy: approverIdentity, baseline: createSnapshot(current.data.policy, current.data.rules, current.data.cases), candidate, baselineVersionId: current.data.versions.at(-1)?.id ?? null, candidateVersionId, createdAt }));
    }
    const activityBase = undoActivityBase(event, current.data.activity, restored.activity);
    const undoEvent: ActivityEvent = { id: nextActivityId(current.data.activity, current.undo, restored.activity), actor: "human", action: `Undid: ${event.action}`, detail: event.changeKind === "workspace_replace" ? "Restored the prior independent simulation and its original audit history." : "Restored the prior workspace state and retained its impact evidence.", createdAt: new Date().toISOString(), undoable: false };
    restored.activity = [undoEvent, ...activityBase].slice(0, WORKSPACE_LIMITS.activity);
    if (!safeWorkspace(restored)) { setAnnouncement("The rollback could not be validated and was not applied."); return; }
    const undo = { ...current.undo }; delete undo[event.id]; publish({ data: restored, undo }); alignWorkspaceSelections(restored); setAnnouncement(`Undid ${event.action}.`);
  }

  function submitPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFormError(""); const form = new FormData(event.currentTarget); const capacity = Number(form.get("capacity")); const reserve = Number(form.get("reserve"));
    const name = String(form.get("name") ?? "").trim(), objective = String(form.get("objective") ?? "").trim(), label = String(form.get("resourceLabel") ?? "").trim(), unit = String(form.get("unit") ?? "").trim();
    const strategy = String(form.get("strategy")) as AllocationStrategy, windowHours = Number(form.get("windowHours"));
    const editedResource = { ...mainResource, label, unit, capacity, reserve, strategy, divisible: strategy === "slot" || strategy === "rate_limit" ? false : form.get("divisible") === "on" };
    if (strategy === "rate_limit") editedResource.windowSeconds = windowHours * 3_600; else delete editedResource.windowSeconds;
    if (!name || !objective || !label || !unit || !Number.isFinite(capacity) || capacity < (needsConfiguration ? 0.000001 : 0) || capacity > 100_000_000 || !Number.isFinite(reserve) || reserve < 0 || reserve > capacity) { setFormError(needsConfiguration ? "Enter the policy text and a user-supplied capacity greater than zero; reserve cannot exceed capacity." : "Enter valid policy text, capacity, and a reserve no greater than capacity."); return; }
    if (resourceRequiresWholeUnits(editedResource) && (!Number.isInteger(capacity) || !Number.isInteger(reserve))) { setFormError(`${label} capacity and reserve must use whole ${unit}.`); return; }
    if (strategy === "rate_limit" && (!Number.isFinite(windowHours) || windowHours <= 0 || windowHours > 8_760)) { setFormError("Enter a rate window greater than zero and no longer than one year."); return; }
    try {
      const schemaJson = String(form.get("schemaJson") ?? "").trim();
      if (schemaJson) {
        const imported = JSON.parse(schemaJson) as unknown; if (!policyIsValid(imported)) throw new Error("The JSON must contain a complete valid policy with fields, resources, a primary resource, ranking, outcomes, name, and objective.");
        if (form.get("resetSchema") !== "on") throw new Error("Confirm the schema reset before replacing fields and resources.");
        if (data.ledger.length > 0 || data.executions.length > 0) throw new Error("Schema replacement is blocked after execution evidence exists. Export the audit file and use a separate workspace for the new schema.");
        commit((draft) => { draft.policy = structuredClone(imported); draft.rules = []; draft.cases = []; draft.ledger = []; draft.executions = []; draft.presetId = "custom"; }, "human", "Policy schema replaced", "Installed a complete policy schema and reset incompatible requests, ledger events, and external actions while preserving prior policy history."); setEditor(null); return;
      }
      commit((draft) => { draft.policy = { ...draft.policy, name, objective, outcomes: { eligible: String(form.get("eligible") ?? "").trim(), boundary: String(form.get("boundary") ?? "").trim(), review: String(form.get("review") ?? "").trim() }, resources: draft.policy.resources.map((resource) => resource.id === draft.policy.primaryResourceId ? editedResource : resource) }; draft.presetId = "custom"; }, "human", "Policy details updated", `Updated ${name}.`); setEditor(null);
    } catch (error) { setFormError(error instanceof Error ? error.message : "Policy update failed."); }
  }
  function submitDefinition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFormError(""); const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim(), objective = String(form.get("objective") ?? "").trim(), resourceLabel = String(form.get("resourceLabel") ?? "").trim(), unit = String(form.get("unit") ?? "").trim();
    const tolerance = Number(form.get("boundaryTolerance")) / 100, maximumFailedRules = Number(form.get("maximumFailedRules")), base = Number(form.get("baseScore")), minimum = Number(form.get("minimumScore")), maximum = Number(form.get("maximumScore")), capacity = Number(form.get("capacity")), reserve = Number(form.get("reserve"));
    const owner = String(form.get("owner") ?? "").trim(), status = String(form.get("status")) as NonNullable<Policy["governance"]>["status"], effectiveFrom = String(form.get("effectiveFrom") ?? "").trim(), effectiveUntil = String(form.get("effectiveUntil") ?? "").trim();
    if (!name || !objective || !resourceLabel || !unit || !Number.isFinite(capacity) || capacity < (needsConfiguration ? 0.000001 : 0) || capacity > 100_000_000 || !Number.isFinite(reserve) || reserve < 0 || reserve > capacity) { setFormError(needsConfiguration ? "Complete the scope and enter a user-supplied capacity greater than zero; reserve cannot exceed capacity." : "Complete the scope and enter a valid capacity with a reserve no greater than capacity."); return; }
    const strategy = String(form.get("strategy")) as AllocationStrategy, windowHours = Number(form.get("windowHours"));
    const candidateResource = { ...mainResource, label: resourceLabel, unit, capacity, reserve, strategy, divisible: strategy === "slot" || strategy === "rate_limit" ? false : form.get("divisible") === "on" };
    if (strategy === "rate_limit") candidateResource.windowSeconds = windowHours * 3_600; else delete candidateResource.windowSeconds;
    if (resourceRequiresWholeUnits(candidateResource) && (!Number.isInteger(capacity) || !Number.isInteger(reserve))) { setFormError(`${resourceLabel} capacity and reserve must use whole ${unit}.`); return; }
    if (strategy === "rate_limit" && (!Number.isFinite(windowHours) || windowHours <= 0 || windowHours > 8_760)) { setFormError("Enter a rate window greater than zero and no longer than one year."); return; }
    const candidate: Policy = { ...data.policy, name, objective, boundary: { tolerance, maximumFailedRules }, scoring: { base, minimum, maximum }, resources: data.policy.resources.map((resource) => resource.id === data.policy.primaryResourceId ? candidateResource : resource), governance: { owner, status, ...(effectiveFrom ? { effectiveFrom } : {}), ...(effectiveUntil ? { effectiveUntil } : {}), requireApproval: form.get("requireApproval") === "on", requireRationale: form.get("requireRationale") === "on" } };
    if (!policyIsValid(candidate)) { setFormError("Review the eligibility, scoring, limits, effective dates, and governance settings. Scores must be ordered minimum ≤ base ≤ maximum."); return; }
    try { commit((draft) => { draft.policy = structuredClone(candidate); draft.presetId = "custom"; }, "human", "Policy definition updated", `${owner} set ${name} to ${status}; boundary tolerance ${Math.round(tolerance * 100)}%.`); setEditor(null); }
    catch (error) { setFormError(error instanceof Error ? error.message : "The policy definition could not be saved."); }
  }
  function submitRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFormError(""); const form = new FormData(event.currentTarget); const field = String(form.get("field")); const operator = String(form.get("operator")) as Operator; const kind = String(form.get("kind")) as RuleKind; const fieldDef = data.policy.fields.find((item) => item.key === field);
    try {
      const base = { label: String(form.get("label") ?? "").trim(), conditions: [{ field, operator, value: parseConditionValue(String(form.get("value") ?? ""), fieldDef, operator) }], match: "all" as const, kind, points: kind === "score" ? Number(form.get("points")) : 0, result: kind === "outcome" ? String(form.get("result")) as PolicyRule["result"] : null, resourceId: kind === "cap" ? String(form.get("resourceId")) : null, amount: kind === "cap" ? Number(form.get("amount")) : 0, priority: Number(form.get("priority") ?? 0), enabled: editingRule?.enabled ?? true };
      const errors = validateRule({ ...base, id: editingRule?.id ?? "pending" }, data.policy); if (errors.length) { setFormError(errors.join(" ")); return; }
      if (editingRule) commit((draft) => { draft.rules = draft.rules.map((rule) => rule.id === editingRule.id ? { ...base, id: editingRule.id } : rule); }, "human", `${base.label} updated`, `Edited ${editingRule.id}.`);
      else { const id = nextRuleId(data); commit((draft) => { draft.rules.push({ ...base, id }); }, "human", `${base.label} added`, `Added ${id}.`); }
      setEditor(null); setEditingRule(null);
    } catch (error) { setFormError(error instanceof Error ? error.message : "Rule update failed."); }
  }
  function submitCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFormError(""); if (editingCase && data.ledger.some((entry) => entry.requestId === editingCase.id)) { setFormError("Requests with ledger history are immutable. Add a corrected request so the execution record remains attributable."); return; } const form = new FormData(event.currentTarget); const name = String(form.get("name") ?? "").trim(); if (!name || data.cases.some((item) => item.id !== editingCase?.id && item.name.toLowerCase() === name.toLowerCase())) { setFormError("Enter a unique request name."); return; }
    const values: Record<string, FieldValue> = {};
    try {
      for (const field of data.policy.fields) { const raw = String(form.get(`field:${field.key}`) ?? ""); if (field.type === "boolean") values[field.key] = raw === "true"; else if (field.type === "number" || field.type === "integer") { const numeric = Number(raw); if (!Number.isFinite(numeric) || numeric < (field.min ?? -100_000_000) || numeric > (field.max ?? 100_000_000) || field.type === "integer" && !Number.isInteger(numeric)) throw new Error(`${field.label} must be ${field.type === "integer" ? "a whole number inside" : "inside"} its allowed range.`); values[field.key] = numeric; } else { if (!field.options?.includes(raw)) throw new Error(`${field.label} is invalid.`); values[field.key] = raw; } }
      const demands: Record<string, number> = {}, minimums: Record<string, number> = {}; for (const resource of data.policy.resources) { demands[resource.id] = Number(form.get(`demand:${resource.id}`)); minimums[resource.id] = Number(form.get(`minimum:${resource.id}`)); if (!Number.isFinite(demands[resource.id]) || demands[resource.id] < 0 || !Number.isFinite(minimums[resource.id]) || minimums[resource.id] < 0 || minimums[resource.id] > demands[resource.id]) throw new Error(`${resource.label} demand and minimum are invalid.`); if (resourceRequiresWholeUnits(resource) && (!Number.isInteger(demands[resource.id]) || !Number.isInteger(minimums[resource.id]))) throw new Error(`${resource.label} demand and minimum must use whole ${resource.unit}.`); if ((editingCase?.actualUsage[resource.id] ?? 0) > demands[resource.id]) throw new Error(`${resource.label} demand cannot be lower than already recorded usage.`); } if (!data.policy.resources.some((resource) => demands[resource.id] > 0)) throw new Error("At least one resource demand must be greater than zero.");
      const item: TestCase = { id: editingCase?.id ?? nextId("C", data.cases), name, values, demands, minimums, actualUsage: editingCase?.actualUsage ?? {}, group: String(form.get("group") ?? "").trim() || undefined, ...(editingCase?.source ? { source: editingCase.source } : {}) };
      if (editingCase) commit((draft) => { draft.cases = draft.cases.map((entry) => entry.id === editingCase.id ? item : entry); }, "human", `${name} updated`, `Updated request ${item.id}.`);
      else commit((draft) => { draft.cases.push(item); }, "human", `${name} added`, "Added one request for policy evaluation.");
      setSelectedCaseId(item.id); setEditingCase(null); setEditor(null);
    } catch (error) { setFormError(error instanceof Error ? error.message : "Request could not be added."); }
  }
  function confirmCaseRemoval() { if (!pendingCaseRemoval) return; const item = pendingCaseRemoval; if (data.ledger.some((event) => event.requestId === item.id) || data.executions.some((execution) => execution.requestId === item.id)) { setFormError("Requests with execution history cannot be removed. Preserve the evidence and update the request instead."); return; } try { commit((draft) => { draft.cases = draft.cases.filter((entry) => entry.id !== item.id); }, "human", `${item.name} removed`, `Removed request ${item.id} before execution.`); setPendingCaseRemoval(null); setSelectedCaseId(data.cases.find((entry) => entry.id !== item.id)?.id ?? ""); setFormError(""); } catch (error) { setFormError(error instanceof Error ? error.message : "The request could not be removed."); } }
  function submitVersion(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setFormError(""); const form = new FormData(event.currentTarget); const label = String(form.get("label") ?? "").trim(), suppliedRationale = String(form.get("rationale") ?? "").trim(); if (!label || activeGovernancePolicy.requireRationale && !suppliedRationale) { setFormError(activeGovernancePolicy.requireRationale ? "Version label and rationale are required by this policy." : "Version label is required."); return; } const rationale = suppliedRationale || "No rationale required by policy."; const id = nextId("V", data.versions); try { commit((draft) => { draft.versions.push({ id, label, rationale, createdAt: new Date().toISOString(), snapshot: createSnapshot(draft.policy, draft.rules, draft.cases) }); }, "human", `${label} saved`, rationale, false); setBaselineId(id); setEditor(null); } catch (error) { setFormError(error instanceof Error ? error.message : "The version could not be saved."); } }
  function submitReconciliation(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!selectedCase || !selectedAllocation) return; const form = new FormData(event.currentTarget); const resourceId = String(form.get("resourceId")); const usage = Number(form.get("actualUsage")); const key = `human-${selectedCase.id}-${resourceId}-${nextId("TX", data.ledger)}`; try { commit((draft) => { Object.assign(draft, reconcileResourceUsage(draft, selectedCase.id, resourceId, usage, "human", key)); }, "human", "Usage reconciled", `${selectedCase.name} consumed ${usage}; unused capacity was released.`, false); setEditor(null); setActiveTab("ledger"); } catch (error) { setFormError(error instanceof Error ? error.message : "Reconciliation failed."); } }
  function applyOperatorApp(next: AppState) {
    const serialized = JSON.stringify(next);
    lastSavedRef.current = serialized;
    appRef.current = next;
    setApp(next);
    alignWorkspaceSelections(next.data);
    setSyncStatus("saved");
    setStorageWarning(null);
  }
  async function submitOperator(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!operatorPrompt.trim() || operatorBusy || operatorExecutionBusy) return;
    setSubmittedPrompt(operatorPrompt.trim()); setAssistantError("");
    setOperatorBusy(true); setOperatorError(""); setOperatorResult(null); setAnnouncement(operatorReadOnly ? "Reviewing the entire portfolio without changes." : "Policy operator is inspecting the connected request.");
    try {
      if (JSON.stringify(appRef.current) !== lastSavedRef.current) throw new Error("Wait for workspace changes to finish saving before running the operator.");
      const result = await runPolicyOperator(operatorPrompt, operatorReadOnly);
      if (!result.readOnly) applyOperatorApp(result.app);
      setOperatorResult(result);
      const proposed = result.pendingExecutionId ? result.app.data.executions.find((item) => item.id === result.pendingExecutionId) : null;
      if (!result.readOnly && proposed?.status === "approved" && proposed.authorizationMode === "policy_automatic") {
        try {
          const executed = await executeWithPolicyOperator(proposed.id);
          const completed = executed.app.data.executions.find((item) => item.id === proposed.id);
          const finalResult = { ...result, app: executed.app, pendingExecutionId: null, message: `${result.message} The active policy authorized the exact action, and GitHub confirmed its execution.`, trace: [...result.trace, { tool: proposed.tool, title: "Execute exact GitHub action", status: "completed" as const, detail: completed?.receipt?.summary ?? "GitHub confirmed the authorized action." }] };
          applyOperatorApp(executed.app); setOperatorResult(finalResult); setAnnouncement("The policy-authorized action completed and its receipt was recorded.");
          return;
        } catch (error) {
          const latest = await loadCloudWorkspace(); if (latest) applyOperatorApp(latest);
          setAssistantError(`${friendlyOperatorError(error)} Check its saved status under External actions.`);
          setAnnouncement("The action was authorized, but GitHub execution did not complete.");
          return;
        }
      }
      setAnnouncement(result.pendingExecutionId ? "The operator prepared an action for review." : "The policy operator completed its inspection.");
    } catch (error) { setAssistantError(friendlyOperatorError(error)); setAnnouncement("The policy operator could not continue."); }
    finally { setOperatorBusy(false); }
  }
  async function submitBatch(selections: BatchSelection[]) {
    if (operatorBusy || operatorExecutionBusy) return;
    setOperatorBusy(true); setOperatorError("");
    try {
      if (syncStatus !== "saved" || JSON.stringify(appRef.current) !== lastSavedRef.current) throw new Error("Wait for workspace changes to finish saving before reviewing requests.");
      const result = await reviewPolicyBatch(selections);
      applyOperatorApp(result.app);
      for (const row of result.batch.rows) {
        const action = result.app.data.executions.find((item) => item.id === row.executionId);
        if (action?.status === "approved" && action.authorizationMode === "policy_automatic" && !action.attempt) {
          try { const completed = await executeWithPolicyOperator(action.id); applyOperatorApp(completed.app); }
          catch (error) { const latest = await loadCloudWorkspace(); if (latest) applyOperatorApp(latest); throw error; }
        }
      }
      setAnnouncement("All selected requests were evaluated together. Their decisions are saved.");
    } catch (error) { setOperatorError(error instanceof CloudApiError && error.detail ? error.detail : friendlyOperatorError(error)); }
    finally { setOperatorBusy(false); }
  }
  async function submitIncomingRequests(requests: AgentRequestInput[]) {
    if (operatorBusy || operatorExecutionBusy) throw new Error("Wait for the current operation to finish.");
    setOperatorBusy(true); setOperatorError("");
    try {
      if (user && (syncStatus !== "saved" || JSON.stringify(appRef.current) !== lastSavedRef.current)) throw new Error("Wait for workspace changes to finish saving before receiving requests.");
      const result = user ? await receiveInboxRequests(requests) : await receiveAgentRequests(appRef.current, requests);
      if (user) applyOperatorApp(result.app); else { appRef.current = result.app; setApp(result.app); }
      setActiveTab("inbox"); setAnnouncement(result.received.length ? `${countNoun(result.received.length, "request")} received into the shared budget inbox.` : "Existing requests retained. No duplicate requests or authorizations added.");
      const view = await requestInboxView(result.app.data);
      return { received: result.received, duplicates: result.duplicates, requests: view.rows.filter((row) => [...result.received, ...result.duplicates].includes(row.requestId)).map(({ requestId, status, proposed, authorized, unit }) => ({ requestId, status, proposed, authorized, unit })) };
    } catch (error) { const message = error instanceof CloudApiError && error.detail ? error.detail : error instanceof Error ? error.message : "Request intake failed."; setOperatorError(message); throw new Error(message); }
    finally { setOperatorBusy(false); }
  }
  async function decideIncomingBudget(input: { request_id: string; decision: "approve" | "reject"; review_fingerprint: string; rationale: string }) {
    if (operatorBusy || operatorExecutionBusy) throw new Error("Wait for the current operation to finish.");
    setOperatorBusy(true); setOperatorError("");
    try {
      if (user && (syncStatus !== "saved" || JSON.stringify(appRef.current) !== lastSavedRef.current)) throw new Error("Wait for workspace changes to finish saving before deciding.");
      if (user) { const result = await decideInboxBudget(input); applyOperatorApp(result.app); }
      else { const next = await decideInboxRequest(appRef.current, input, "Local reviewer"); appRef.current = next; setApp(next); }
      setAnnouncement(input.decision === "approve" ? "Budget authorized and reserved in the resource ledger." : "Request declined. Decision retained in the audit history; no budget reserved.");
    } catch (error) { const message = error instanceof CloudApiError && error.detail ? error.detail : error instanceof Error ? error.message : "Decision failed."; setOperatorError(message); throw new Error(message); }
    finally { setOperatorBusy(false); }
  }
  async function refreshIncomingRequests() {
    if (!user || operatorBusy || operatorExecutionBusy) return;
    if (JSON.stringify(appRef.current) !== lastSavedRef.current) { setOperatorError("Save your current changes before refreshing incoming requests."); return; }
    setOperatorBusy(true); setOperatorError("");
    try { const latest = await loadCloudWorkspace(); if (latest) { applyOperatorApp(latest); setAnnouncement("Incoming requests refreshed."); } }
    catch { setOperatorError("The inbox could not be refreshed. Your current workspace was retained."); }
    finally { setOperatorBusy(false); }
  }
  async function verifyIncomingRequest(id: string) {
    const entry = appRef.current.data.inbox?.find((item) => item.requestId === id);
    if (!entry?.execution) return;
    if (!operatorReadiness(operatorStatus, Boolean(user)).batchReady) { setOperatorError("The request is received. Connect its GitHub action adapter in Connections before verifying external evidence."); return; }
    await submitBatch([{ reference: entry.execution.reference, ...(entry.execution.budget ? { budget: entry.execution.budget } : {}) }]);
  }
  async function disconnectOperatorGitHub() {
    setOperatorBusy(true); setOperatorError("");
    try { await disconnectGitHub(); setOperatorStatus((current) => current ? { ...current, connected: false, account: undefined } : current); setOperatorResult(null); setAnnouncement("GitHub disconnected from the policy operator."); }
    catch (error) { setOperatorError(friendlyOperatorError(error)); }
    finally { setOperatorBusy(false); }
  }
  async function refreshOperatorConnections() {
    if (connectionRefreshing || operatorBusy || operatorExecutionBusy || !user) return;
    setConnectionRefreshing(true); setOperatorError("");
    try { setOperatorStatus(await getOperatorConnectionStatus()); setAnnouncement("Connection status checked."); }
    catch { setOperatorStatus(null); setOperatorError("Connection status could not be checked. Try again; no workspace data was changed."); }
    finally { setConnectionRefreshing(false); }
  }
  async function approveAndExecuteWithOperator(execution: ExternalExecution) {
    if (operatorExecutionBusy) return;
    setOperatorExecutionBusy(execution.id); setFormError("");
    try {
      if (JSON.stringify(appRef.current) !== lastSavedRef.current) throw new Error("Wait for workspace changes to finish saving before execution.");
      const result = await executeWithPolicyOperator(execution.id);
      applyOperatorApp(result.app); setExternalReviewId(null); setActiveTab("executions"); setOperatorResult((current) => current ? { ...current, app: result.app, pendingExecutionId: null, message: "GitHub completed the exact approved action. RuleRipple recorded its receipt and committed the authorization." } : current); setAnnouncement("GitHub completed the approved action and RuleRipple recorded its receipt.");
    } catch (error) {
      setFormError(friendlyOperatorError(error));
      try { const latest = await loadCloudWorkspace(); if (latest) { applyOperatorApp(latest); setExternalReviewId(null); setActiveTab("executions"); } } catch { /* Retain the last confirmed state and the original error. */ }
    }
    finally { setOperatorExecutionBusy(null); }
  }
  async function authenticate(mode: "signin" | "signup", email: string, password: string) { setAuthBusy(true); setAuthError(""); try { const nextUser = await authenticateCloud(mode, email, password); await hydrateAuthenticatedWorkspace(nextUser); } catch (error) { setAuthError(friendlyAuthError(error)); } finally { setAuthBusy(false); } }
  async function copyAgentPrompt(step: AgentWorkflowStep) {
    try {
      await copyText(step.prompt); setCopiedPromptId(step.id); setAnnouncement(`${step.title} agent prompt copied.`);
      if (copyResetTimerRef.current) window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => setCopiedPromptId((current) => current === step.id ? null : current), 2200);
    } catch { setAnnouncement("The prompt could not be copied. Select the visible prompt text instead."); }
  }
  function enterGuestWorkspace() { const fresh = freshAppState(); resetTransientWorkspaceUi(); guestModeRef.current = true; setGuestMode(true); appRef.current = fresh; setApp(fresh); alignWorkspaceSelections(fresh.data); setHydrated(true); setSyncStatus("idle"); setAnnouncement("Local session ready. Sign in to sync your work across sessions."); }
  function requestWorkspaceExit() { if (guestMode) setLeaveConfirmationOpen(true); else void handleSignOut(); }
  async function handleSignOut() { if (guestMode) { resetTransientWorkspaceUi(); guestModeRef.current = false; setGuestMode(false); setHydrated(false); return; } try { await signOutCloud(); } catch { setSessionWarning("Sign out could not be confirmed by the server. You are still signed in; try again."); return; } const fresh = freshAppState(); resetTransientWorkspaceUi(); setUser(null); appRef.current = fresh; setApp(fresh); alignWorkspaceSelections(fresh.data); lastSavedRef.current = ""; setHydrated(false); setSyncStatus("idle"); }

  if (!authReady) return <CloudLoading label="Checking your secure session…" />; if (!user && !guestMode) return <AuthScreen busy={authBusy} error={authError} onAuthenticate={authenticate} onGuest={enterGuestWorkspace} />; if (cloudLoadError && !guestMode) return <CloudFailure message={cloudLoadError} onRetry={() => window.location.reload()} onSignOut={handleSignOut} />; if (!hydrated) return <CloudLoading label="Loading your private workspace…" />;

  const ledgerState = resourceLedgerState(mainResource, data.ledger); const mainSummary = portfolio.resources.find((item) => item.resourceId === mainResource.id)!;
  const selectedInboxEntry = data.inbox?.find((entry) => entry.requestId === selectedCase?.id);
  const reconciliationAmounts = Object.fromEntries(data.policy.resources.map((resource) => {
    const held = resourceLedgerState({ ...resource, capacity: Number.MAX_SAFE_INTEGER, reserve: 0 }, data.ledger.filter((event) => event.requestId === selectedCase?.id && event.resourceId === resource.id));
    return [resource.id, selectedInboxEntry && !selectedInboxEntry.execution ? selectedInboxEntry.decision?.status === "approved" ? held.reserved + held.committed + held.consumed : 0 : selectedAllocation?.resources[resource.id]?.allocated ?? 0];
  }));
  const reconciliationResources = data.policy.resources.filter((resource) => reconciliationAmounts[resource.id] > 0);
  const reconciliationResource = reconciliationResources.find((resource) => resource.id === reconciliationResourceId) ?? reconciliationResources[0] ?? mainResource;
  const reconciliationAllocation = selectedAllocation ? { ...selectedAllocation.resources[reconciliationResource.id], allocated: reconciliationAmounts[reconciliationResource.id] } : undefined;
  const reconciliationLedgerState = selectedCase ? resourceLedgerState({ ...reconciliationResource, capacity: Number.MAX_SAFE_INTEGER, reserve: 0 }, data.ledger.filter((event) => event.requestId === selectedCase.id && event.resourceId === reconciliationResource.id)) : null;
  const activeAgentWorkflowSteps = agentWorkflowStepsForWorkspace(data.rules.length, data.cases.length);
  const pendingProposalComparison = pendingPolicyChange ? compareSimulationSnapshots(createSnapshot(pendingPolicyChange.baseline.policy, pendingPolicyChange.baseline.rules, pendingPolicyChange.baseline.cases), createSnapshot(pendingPolicyChange.candidate.policy, pendingPolicyChange.candidate.rules, pendingPolicyChange.candidate.cases)) : null;
  const pendingExternalExecution = data.executions.find((item) => item.id === externalReviewId && item.status === "pending_approval");
  const approvedExternalExecutionToRevoke = data.executions.find((item) => item.id === externalRevokeId && item.status === "approved");
  const operatorReady = operatorReadiness(operatorStatus, Boolean(user)).batchReady;
  const section = tabs.find((tab) => tab.id === activeTab)!;
  const pageTitle = needsConfiguration ? isBlankWorkspace ? "Define your policy" : `Configure ${data.policy.name}` : section.title;
  const pageDescription = needsConfiguration ? "No capacity, reserve, rules, requests, or assignments are assumed. Supply the policy values before simulation begins." : section.description;
  const reviewKey = (workspace: WorkspaceData) => JSON.stringify([workspace.policy, workspace.rules, workspace.cases, workspace.ledger, workspace.executions]);
  const assistantStale = Boolean(operatorResult && reviewKey(data) !== reviewKey(operatorResult.app.data));
  const reviewAssistantAction = (executionId: string) => {
    if (assistantCompact) setAssistantOpen(false);
    const execution = data.executions.find((item) => item.id === executionId); setFormError("");
    if (execution?.status === "pending_approval") setExternalReviewId(executionId); else setActiveTab("executions");
  };
  const assistantContent = <PolicyAssistant tab={activeTab} policyName={data.policy.name} configured={!needsConfiguration} signedIn={Boolean(user)} status={operatorStatus} readOnly={operatorReadOnly} onMode={(value) => { setOperatorReadOnly(value); setOperatorPrompt(""); }} prompt={operatorPrompt} onPrompt={setOperatorPrompt} submittedPrompt={submittedPrompt} result={operatorResult} stale={assistantStale} busy={operatorBusy || Boolean(operatorExecutionBusy)} error={assistantError} requiresApproval={activeGovernancePolicy.requireApproval} onSubmit={submitOperator} onClose={assistantCompact ? undefined : () => setAssistantOpen(false)} onConnections={() => { setActiveTab("operator"); if (assistantCompact) setAssistantOpen(false); }} onEvidence={() => { if (assistantCompact) setAssistantOpen(false); setAssistantEvidenceOpen(true); }} onReview={reviewAssistantAction} />;
  return <main className="app-shell">
    <div className="sr-only" aria-live="polite">{announcement}</div>
    <header className="topbar"><div className="brand-lockup"><div className="brand-mark" aria-hidden="true">RR</div><div><p className="brand-name">RuleRipple</p><p className="brand-tagline">Policy decisions, made visible.</p></div></div><div className="topbar-actions"><button className="button assistant-toggle" type="button" aria-expanded={assistantOpen} aria-controls="workspace-assistant" onClick={() => setAssistantOpen(!assistantOpen)}><AssistantIcon />Assistant{operatorBusy && <span className="assistant-working-dot" aria-label="Working" />}</button><span className={`cloud-pill cloud-${syncStatus}`}><span className="status-dot" />{guestMode ? "Local only" : syncStatus === "saved" ? "Cloud saved" : syncStatus === "saving" ? "Saving…" : syncStatus === "error" ? "Save failed" : "Cloud ready"}</span><span className={`status-pill status-${webMCPStatus}`}><span className="status-dot" />{statusCopy}</span><div className="account-menu"><span>{guestMode ? "Local session" : "Workspace owner"}</span><button type="button" onClick={requestWorkspaceExit}>{guestMode ? "Exit session" : "Sign out"}</button></div>{!needsConfiguration && <button className="button secondary" type="button" title="Export the policy, requests, reports, allocations, and ledger as JSON" onClick={exportAuditFile}>Export audit file</button>}</div></header>
    {guestMode && <div className="workspace-notice"><strong>Local session:</strong> {needsConfiguration ? "No policy has been configured yet." : data.cases.length ? `${data.cases.length} request${data.cases.length === 1 ? " is" : "s are"} loaded; all assignments are calculated from ${data.cases.length === 1 ? "its" : "their"} current inputs.` : "The policy is configured and ready for requests."} This work exists only in this browser tab. Sign in to sync it across sessions.</div>}
    {storageWarning && <div className="storage-warning" role="alert">{storageWarning} <button type="button" onClick={() => storageWarning.includes("another tab") ? window.location.reload() : setSaveRetry((value) => value + 1)}>{storageWarning.includes("another tab") ? "Reload cloud version" : "Retry"}</button>{!needsConfiguration && <button type="button" onClick={exportAuditFile}>Export audit file</button>}</div>}
    {sessionWarning && <div className="storage-warning" role="alert">{sessionWarning} <button type="button" onClick={handleSignOut}>Retry sign out</button><button type="button" onClick={() => setSessionWarning(null)}>Dismiss</button></div>}
    <div className={`workspace workspace-redesign ${needsConfiguration ? "needs-configuration" : ""} ${activeTab === "inbox" ? "inbox-workspace" : ""} ${assistantOpen && !assistantCompact ? "with-assistant" : ""}`}>
      <aside className="sidebar"><button className="program-switcher" type="button" onClick={() => openResourceEditor("definition")}><span className="eyebrow">{needsConfiguration ? "Policy setup" : "Active policy"}</span><strong>{isBlankWorkspace ? "No policy configured" : data.policy.name}</strong><span>{needsConfiguration ? "Waiting for your values" : `${mainResource.label} · ${allocationStrategyLabels[mainResource.strategy]}`}</span></button><button className="library-button" type="button" onClick={() => setLibraryOpen(true)}>Choose policy template</button><nav aria-label="Workspace sections" className="nav-list">{navigationGroups.map((group) => <div className="nav-group" key={group}><span className="nav-group-label">{group}</span>{tabs.filter((tab) => tab.group === group).map((tab) => <button className={`nav-item ${activeTab === tab.id ? "active" : ""}`} aria-current={activeTab === tab.id ? "page" : undefined} key={tab.id} type="button" disabled={needsConfiguration && tab.id !== "canvas"} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}</div>)}</nav><div className="sidebar-note"><span className="eyebrow">Design principle</span><p>The agent proposes. The active policy decides when a human checkpoint is required.</p></div></aside>
      <section className={`main-panel ${needsConfiguration ? "needs-configuration" : ""}`}><div className="title-row"><div><span className="eyebrow">{needsConfiguration ? "New workspace" : tabs.find((tab) => tab.id === activeTab)?.label}</span><h1>{pageTitle}</h1><p>{pageDescription}</p>{!needsConfiguration && activeTab === "canvas" && <div className="title-meta" aria-label="Current policy settings"><span>{mainResource.label}</span><span>Configured capacity {displayAmount(mainResource.capacity, mainResource.unit)}</span><span>Protected reserve {displayAmount(mainResource.reserve, mainResource.unit)}</span><span>{allocationStrategyLabels[mainResource.strategy]}</span>{mainResource.strategy === "rate_limit" && <span>Resets every {formatRateWindow(mainResource.windowSeconds)}</span>}</div>}</div>{!needsConfiguration && activeTab !== "canvas" && <button className="icon-button" type="button" onClick={() => openResourceEditor("policy")}>Policy settings</button>}</div>
        {needsConfiguration && <section className="canvas-card policy-setup"><span className="eyebrow">Configuration required</span><h2>{isBlankWorkspace ? "Start with your own policy" : "Template selected; values still required"}</h2><p>{isBlankWorkspace ? "Define the decision, typed inputs, resource unit, capacity, reserve, allocation strategy, and governance. Nothing is calculated until you provide them." : `${data.policy.name} supplies only field and resource structure. Capacity, reserve, rate window, rule thresholds, requests, and assignments remain unset.`}</p><div className="policy-setup-actions"><button className="button primary" type="button" onClick={() => openResourceEditor("definition")}>Define policy values</button><button className="button secondary" type="button" onClick={() => setLibraryOpen(true)}>Choose a policy template</button></div><small>Agents can also create a complete policy through WebMCP. The governance mode you configure determines whether approval is required.</small></section>}
        {activeTab === "operator" && !needsConfiguration && <><ConnectionsPanel status={operatorStatus} signedIn={Boolean(user)} policy={data.policy} data={data} busy={operatorBusy || Boolean(operatorExecutionBusy)} refreshing={connectionRefreshing} onRefresh={refreshOperatorConnections} error={operatorError} onDisconnect={disconnectOperatorGitHub} onAssistant={() => setAssistantOpen(true)} /><section className="canvas-card workspace-card webmcp-connection"><h2>Browser-agent access</h2><p>{statusCopy}. Browser WebMCP exposes the same policy tools to compatible browser agents. The built-in assistant does not require a WebMCP-capable browser.</p><AgentQuickstart compact steps={activeAgentWorkflowSteps} status={webMCPStatus} copiedPromptId={copiedPromptId} onCopy={copyAgentPrompt} requiresApproval={activeGovernancePolicy.requireApproval} /></section></>}
        {activeTab === "canvas" && !needsConfiguration && (!data.rules.length || !data.cases.length) && <section className="setup-guide" aria-label="Workspace setup progress"><div className="setup-guide-copy"><span className="eyebrow">Next step</span><h2>{!data.rules.length ? "Add the rules that decide eligibility and priority" : "Add requests to see who receives the resource"}</h2><p>{!data.rules.length ? "Start with one clear eligibility threshold. You can add scoring and allocation caps after the basic decision path is visible." : "Requests use the typed fields you selected. RuleRipple will calculate outcomes, ranks, assignments, and remaining capacity."}</p></div><div className="setup-steps" aria-label="Setup steps"><span className="done"><b>1</b><small>Policy</small><strong>Configured</strong></span><span className={data.rules.length ? "done" : "current"}><b>2</b><small>Rules</small><strong>{data.rules.length ? `${data.rules.length} added` : "Required next"}</strong></span><span className={data.cases.length ? "done" : data.rules.length ? "current" : "pending"}><b>3</b><small>Requests</small><strong>{data.cases.length ? `${data.cases.length} added` : data.rules.length ? "Required next" : "After rules"}</strong></span></div><button className="button primary" type="button" onClick={() => data.rules.length ? openCaseEditor() : openRuleEditor()}>{data.rules.length ? "Add first request" : "Add first rule"}</button></section>}
        {activeTab === "inbox" && !needsConfiguration && <RequestInbox data={data} signedIn={Boolean(user)} busy={operatorBusy || Boolean(operatorExecutionBusy)} error={operatorError} onConnect={() => setActiveTab("operator")} onReceive={submitIncomingRequests} onDecide={decideIncomingBudget} onRefresh={refreshIncomingRequests} onVerify={verifyIncomingRequest} onAction={(id) => { setFormError(""); if (data.executions.find((item) => item.id === id)?.status === "pending_approval") setExternalReviewId(id); else setActiveTab("executions"); }} />}
        {activeTab === "canvas" && <PolicyDefinitionOverview policy={data.policy} rules={data.rules} audit={policyAudit} onEdit={() => openResourceEditor("definition")} />}
        {activeTab === "canvas" && <><div className="metrics"><article><span>Rules</span><strong>{data.rules.length}</strong><small>{countNoun(data.policy.fields.length, "typed field")}</small></article><article><span>Eligible</span><strong>{counts.eligible}</strong><small>{countNoun(data.cases.length, "user-supplied request")}</small></article><article><span>Simulated assignments</span><strong>{portfolio.fundedCount}</strong><small>{data.cases.length ? `${displayAmount(mainSummary.allocated, mainResource.unit)} derived from current inputs` : "Waiting for request inputs"}</small></article><article><span>Unassigned capacity</span><strong>{data.cases.length ? displayAmount(mainSummary.remaining, mainResource.unit) : "Not calculated"}</strong><small>{displayAmount(mainResource.reserve, mainResource.unit)} policy reserve</small></article><article className="metric-attention"><span>Boundary</span><strong>{counts.boundary}</strong><small>Need human review</small></article></div><section className="resource-strip">{data.policy.resources.map((resource) => { const summary = portfolio.resources.find((item) => item.resourceId === resource.id)!; return <article key={resource.id}><span className="eyebrow">Configured resource pool</span><strong>{resource.label}</strong><p>{data.cases.length ? `${displayAmount(summary.allocated, resource.unit)} simulated from ${countNoun(data.cases.length, "current request")}` : "No assignment calculated until requests are added"}</p><div className="budget-track"><span style={{ width: data.cases.length ? `${Math.min(100, (summary.allocated / Math.max(summary.allocatable, 1)) * 100)}%` : "0%" }} /></div><small>Capacity {displayAmount(resource.capacity, resource.unit)} · {allocationStrategyLabels[resource.strategy]} · reserve {displayAmount(resource.reserve, resource.unit)}</small></article>; })}</section><section className="canvas-card"><div className="section-heading"><div><span className="eyebrow">Decision logic</span><h2>Evaluation order</h2></div><button className="text-button" type="button" onClick={() => openRuleEditor()}>+ Add rule</button></div><div className={`rule-flow ${orderedRules.length ? "" : "empty"}`}><div className="flow-start">Request</div>{!orderedRules.length && <><span className="connector" /><div className="flow-empty"><strong>No policy rules yet</strong><span>Add an eligibility threshold to make the decision path explicit.</span></div></>}{orderedRules.map((rule, index) => <div className="flow-group" key={rule.id}><span className="connector" /><article className={`rule-node ${tones[index % tones.length]} ${rule.enabled ? "" : "disabled"}`}><div><span>{rule.id} · {rule.kind} · priority {rule.priority}</span><strong>{rule.label}</strong></div><p>{formatRule(rule, data.policy)}</p><div className="node-actions"><button type="button" onClick={() => openRuleEditor(rule)}>Edit</button><button type="button" onClick={() => setPendingRemoval(rule)}>Remove</button></div></article>{index === orderedRules.length - 1 && <><span className="connector" /><div className="flow-end">Rank + simulate assignment</div></>}</div>)}</div></section></>}
        {activeTab === "cases" && <section className="canvas-card workspace-card">
          <div className="section-heading"><div><span className="eyebrow">All requests</span><h2>Request inputs & decisions</h2></div><button className="text-button" type="button" onClick={() => openCaseEditor()}>+ Add request</button></div>
          {data.cases.length ? <><div className="toolbar"><label className="search-field"><span className="sr-only">Search requests</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search requests" /></label><div className="segmented">{(["all", "eligible", "boundary", "review"] as const).map((filter) => <button className={caseFilter === filter ? "active" : ""} key={filter} type="button" onClick={() => setCaseFilter(filter)}>{filter === "all" ? "All" : data.policy.outcomes[filter]}</button>)}</div></div><RequestTable cases={filteredCases} evaluationById={evaluationById} allocationById={allocationById} policy={data.policy} onSelect={setSelectedCaseId} selectedId={selectedCaseId} /></> : <div className="guided-empty"><strong>Add the first request</strong><p>Enter the real fields, demand, and minimum useful allocation you want this policy to evaluate. No values are invented.</p><button className="button primary" type="button" onClick={() => openCaseEditor()}>Add first request</button></div>}
          {selectedCaseIsVisible && selectedCase && selectedEvaluation && selectedAllocation && <div className="trace-panel"><div><span className="eyebrow">Decision trace</span><h3>{selectedCase.name}</h3><p>Score {selectedEvaluation.score} · <span className={`outcome ${selectedEvaluation.outcome}`}>{data.policy.outcomes[selectedEvaluation.outcome]}</span></p>{selectedAllocation.resources[mainResource.id]?.rawRequested !== selectedAllocation.resources[mainResource.id]?.requested && <p className="form-note">Policy cap reduced effective demand from <strong>{displayAmount(selectedAllocation.resources[mainResource.id].rawRequested, mainResource.unit)}</strong> to <strong>{displayAmount(selectedAllocation.resources[mainResource.id].requested, mainResource.unit)}</strong>.</p>}<div className={`funding-callout ${selectedAllocation.funded ? "funded" : "not-funded"}`}><strong>{selectedAllocation.resources[mainResource.id]?.status === "partial" ? `${displayAmount(selectedAllocation.fundedAmount, mainResource.unit)} partially allocated` : selectedAllocation.funded ? `${displayAmount(selectedAllocation.fundedAmount, mainResource.unit)} allocated` : "Not fully allocated"}</strong><span>{selectedAllocation.rank ? `Rank #${selectedAllocation.rank}. ` : ""}{selectedAllocation.reason}</span></div><div className="node-actions">{selectedInboxEntry ? <p className="form-note">Received inputs are retained as submitted. Use Request inbox to review the budget; submit a new request for changed work.</p> : <><button type="button" onClick={() => openCaseEditor(selectedCase)}>Edit request</button><button type="button" onClick={() => { setFormError(""); setPendingCaseRemoval(selectedCase); }}>Remove request</button></>}</div><button className="button secondary" type="button" disabled={!reconciliationResources.length} onClick={() => { const firstAllocatedResource = reconciliationResources[0]; setReconciliationResourceId(firstAllocatedResource?.id ?? mainResource.id); setFormError(""); setEditor("reconcile"); }}>Reconcile request usage</button></div><ol>{selectedEvaluation.trace.map((step) => <li className={step.effect} key={step.ruleId}><span>{step.effect === "passed" ? "✓" : step.effect === "failed" ? "×" : step.effect === "applied" ? "+" : "—"}</span><div><strong>{step.label}</strong><small>{step.message}</small></div></li>)}</ol></div>}
        </section>}
        {activeTab === "impact" && <div className="stack"><section className="canvas-card workspace-card scenario-lab"><div className="section-heading"><div><span className="eyebrow">What-if scenarios</span><h2>Test policy without changing live policy</h2></div><span className="quiet">Live deterministic preview · current inputs</span></div><div className="scenario-block"><span className="eyebrow">Resource policy</span><div className="scenario-controls"><label>Scenario capacity ({mainResource.unit})<input type="number" min="0" max="100000000" step={scenarioUsesWholeUnits ? 1 : "any"} value={scenarioCapacity} onChange={(event) => updateScenarioCapacity(event.target.value)} /></label><label>Protected reserve ({mainResource.unit})<input type="number" min="0" max={scenarioCapacityValue || 0} step={scenarioUsesWholeUnits ? 1 : "any"} value={scenarioReserve} onChange={(event) => updateScenarioReserve(event.target.value)} /></label><label>Allocation strategy<select value={scenarioStrategy} onChange={(event) => updateScenario({ strategy: event.target.value as AllocationStrategy })}>{Object.entries(allocationStrategyLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>{scenarioStrategy === "rate_limit" && <label>Rate window (hours)<input type="number" min="0.000278" max="8760" step="any" value={scenarioWindowHours} onChange={(event) => updateScenario({ windowHours: event.target.value })} /></label>}</div></div><div className="scenario-block"><span className="eyebrow">Behavioral policy · one lever at a time</span><div className="policy-lever-controls"><label>Rule to test<select value={scenarioRuleId} onChange={(event) => updateScenarioRule(event.target.value)}><option value="">No rule change</option>{scenarioRuleLevers.map((rule) => <option value={rule.id} key={rule.id}>{rule.id} · {rule.label}</option>)}</select></label>{selectedScenarioRule && <label>{policyLeverLabel(selectedScenarioRule)}<input type="number" value={scenarioRuleValue} onChange={(event) => updateScenario({ ruleValue: event.target.value })} /></label>}<div className="scenario-actions"><button className="button secondary" type="button" disabled={!scenarioChanged} onClick={resetScenario}>Reset</button><button className="button primary" type="button" disabled={!scenarioValid || !scenarioChanged || scenarioBlockingIssues.length > 0} onClick={applyScenario}>{activeGovernancePolicy.requireApproval ? "Approve & apply" : "Apply to policy"}</button></div></div></div>{!resourceScenarioValid && <p className="form-error">Reserve must be between zero and a valid capacity.</p>}{!scenarioRuleValid && <p className="form-error">Enter a valid value for the selected policy rule.</p>}{scenarioBlockingIssues.length > 0 && <p className="form-error">Resolve policy errors before applying: {scenarioBlockingIssues.map((issue) => issue.message).join(" ")}</p>}{data.cases.length > 0 ? <><div className="assumption-strip"><span>Deterministic</span><span>Same request inputs</span><span>One rule lever</span><span>Caps before ranking</span><span>Minimums enforced</span><span>Stable tie-breaker</span></div><div className="scenario-metrics"><article><span>Effective demand</span><strong>{displayAmount(scenarioSummary.requested, mainResource.unit)}</strong><small>After policy caps</small></article><article><span>Allocatable</span><strong>{displayAmount(scenarioSummary.allocatable, mainResource.unit)}</strong><small>Capacity minus reserve</small></article><article><span>Demand gap</span><strong>{displayAmount(scenarioDemandGap, mainResource.unit)}</strong><small>Eligible demand not allocated</small></article><article><span>Results</span><strong>{scenarioPortfolio.fundedCount} full · {scenarioPartialCount} partial</strong><small>{countNoun(scenarioGapCount, "eligible capacity gap")}</small></article><article><span>Decision changes</span><strong>{scenarioDeltas.length}</strong><small>{countNoun(scenarioOutcomeChanges, "outcome")} · {countNoun(scenarioRankChanges, "rank")}</small></article></div><div className="resource-grid">{scenarioPortfolio.resources.map((summary) => { const resource = scenarioPolicy.resources.find((item) => item.id === summary.resourceId); return resource ? <article key={summary.resourceId}><strong>{resource.label}</strong><span>{displayAmount(summary.allocated, resource.unit)} allocated</span><small>{displayAmount(summary.remaining, resource.unit)} available · {displayAmount(summary.reserve, resource.unit)} protected</small><div className="budget-track"><span style={{ width: `${Math.min(100, (summary.allocated / Math.max(summary.allocatable, 1)) * 100)}%` }} /></div></article> : null; })}</div></> : <p className="empty-state">Add requests to calculate outcomes, ranks, and assignments. Policy capacity and reserve remain configuration only.</p>}</section>{data.cases.length > 0 && scenarioChanged && <section className="case-card workspace-card"><div className="section-heading"><div><span className="eyebrow">Before → scenario</span><h2>{countNoun(scenarioDeltas.length, "decision change")}</h2></div><span className="quiet">No policy mutation until you apply</span></div><div className="delta-list">{scenarioDeltas.map((delta) => { const item = data.cases.find((entry) => entry.id === delta.caseId)!; return <article key={delta.caseId}><div><strong>{item.name}</strong><small>{delta.outcomeChanged && `${delta.beforeOutcome} → ${delta.afterOutcome} · `}{delta.rankChanged && `rank ${delta.beforeRank ?? "—"} → ${delta.afterRank ?? "—"} · `}{displayAmount(delta.beforeAmount, mainResource.unit)} → {displayAmount(delta.afterAmount, mainResource.unit)}</small></div><span className={delta.delta > 0 ? "delta-up" : delta.delta < 0 ? "delta-down" : "delta-note"}>{Math.abs(delta.delta) > 0.000001 ? `${delta.delta > 0 ? "+" : ""}${displayAmount(delta.delta, mainResource.unit)}` : "Policy impact"}</span></article>; })}{!scenarioDeltas.length && <p className="empty-state">This policy change has no material effect on the current requests. That is still a valid simulation result.</p>}</div></section>}{data.cases.length > 0 && <section className="case-card workspace-card"><div className="section-heading"><div><span className="eyebrow">Scenario allocation order</span><h2>Deterministic portfolio ranking</h2></div><span className="quiet">Eligibility → score → cap → rank → allocate</span></div><div className="rank-list">{scenarioPortfolio.allocations.filter((item) => item.rank).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).map((allocation) => { const item = data.cases.find((entry) => entry.id === allocation.caseId)!; const resourceAllocation = allocation.resources[mainResource.id]; return <article className="rank-row" key={item.id}><span className="rank-number">#{allocation.rank}</span><div><strong>{item.name}</strong><small>Score {scenarioEvaluations.get(item.id)?.score} · {resourceAllocation.rawRequested === resourceAllocation.requested ? `asks ${displayAmount(resourceAllocation.requested, mainResource.unit)}` : `asks ${displayAmount(resourceAllocation.rawRequested, mainResource.unit)} · capped to ${displayAmount(resourceAllocation.requested, mainResource.unit)}`} · minimum {displayAmount(resourceAllocation.minimum, mainResource.unit)}</small></div><span className={`funding-badge ${allocation.funded ? "funded" : "not-funded"}`}>{resourceAllocation.status === "partial" ? `${displayAmount(resourceAllocation.allocated, mainResource.unit)} partial` : allocation.funded ? `${displayAmount(resourceAllocation.allocated, mainResource.unit)} full` : "Capacity gap"}</span></article>; })}</div></section>}</div>}
        {activeTab === "versions" && <div className="stack">
          <section className="canvas-card workspace-card">
            <div className="section-heading"><div><span className="eyebrow">Version compare</span><h2>Test a full simulation revision before applying it</h2></div><button className="text-button" type="button" onClick={() => setEditor("version")}>Save full version</button></div>
            {formError && <p className="form-error">{formError}</p>}
            {comparisonRuleLevers.length > 0 ? <>
              <div className="compare-controls three"><label>Baseline<select value={baseline?.id ?? ""} onChange={(event) => setBaselineId(event.target.value)}>{data.versions.map((version) => <option key={version.id} value={version.id}>{version.id} · {version.label}</option>)}</select></label><label>Rule to revise<select value={effectiveCandidateRuleId} onChange={(event) => { const rule = comparisonRuleLevers.find((item) => item.id === event.target.value); setCandidateRuleId(event.target.value); setCandidateValue(String(rule ? policyLeverValue(rule) ?? "" : "")); }}>{comparisonRuleLevers.map((rule) => <option key={rule.id} value={rule.id}>{rule.id} · {rule.label}</option>)}</select></label><label>{candidateRule ? policyLeverLabel(candidateRule) : "Rule value"}<input inputMode="decimal" value={candidateValue} onChange={(event) => setCandidateValue(event.target.value)} /></label></div>
              <div className="comparison-summary"><article><span>Inputs changed</span><strong>{changedInputCount}</strong><small>{countNoun(comparison.changedRules.length, "rule")} · {countNoun(comparison.changedRequests.length, "request")} · {comparison.policyChanged ? "policy changed" : "same policy"}</small></article><article><span>Outcomes changed</span><strong>{comparison.changedCases.length}</strong><small>Baseline snapshot versus candidate</small></article><article><span>Allocations changed</span><strong>{comparison.changedAllocations.length}</strong><small>{countNoun(comparison.changedRanks.length, "rank")} changed · every resource included</small></article></div>
              <div className="approval-row"><p><strong>{candidateChangesCurrent ? "Human checkpoint." : "Candidate matches the current policy."}</strong> Applying creates a version, impact report, activity event, and undo checkpoint.</p><button className="button primary" type="button" disabled={!candidateIsValid || !candidateChangesCurrent} onClick={applyComparedRevision}>Apply revision</button></div>
            </> : <div className="guided-empty"><strong>Add a rule before comparing revisions</strong><p>Version comparison needs an eligibility threshold, score adjustment, or allocation cap with a numeric value to test.</p><button className="button primary" type="button" onClick={() => { setActiveTab("canvas"); openRuleEditor(); }}>Add first rule</button></div>}
          </section>
          <section className="case-card workspace-card"><div className="section-heading"><div><span className="eyebrow">Saved history</span><h2>{countNoun(data.versions.length, "full snapshot")}</h2></div></div><div className="version-list">{[...data.versions].reverse().map((version) => <article key={version.id}><span>{version.id}</span><div><strong>{version.label}</strong><p>{version.rationale}</p></div><time>{new Date(version.createdAt).toLocaleString()}</time></article>)}</div></section>
        </div>}
        {activeTab === "ledger" && <div className="stack"><section className="canvas-card workspace-card"><div className="section-heading"><div><span className="eyebrow">Auditable resource ledger</span><h2>{mainResource.label}</h2></div><span className="quiet">Duplicate-safe execution history</span></div><div className="ledger-metrics"><article><span>Available</span><strong>{displayAmount(ledgerState.available, mainResource.unit)}</strong></article><article><span>Reserved</span><strong>{displayAmount(ledgerState.reserved, mainResource.unit)}</strong></article><article><span>Committed</span><strong>{displayAmount(ledgerState.committed, mainResource.unit)}</strong></article><article><span>Consumed</span><strong>{displayAmount(ledgerState.consumed, mainResource.unit)}</strong></article><article><span>Protected reserve</span><strong>{displayAmount(ledgerState.policyReserve, mainResource.unit)}</strong></article></div></section><section className="case-card workspace-card"><div className="section-heading"><div><span className="eyebrow">Ledger events</span><h2>{data.ledger.length} execution record{data.ledger.length === 1 ? "" : "s"}</h2></div><span className="quiet">Reserve → commit → consume → release</span></div><div className="version-list">{[...data.ledger].slice(-WORKSPACE_LIMITS.ledgerDisplay).reverse().map((event) => <article key={event.id}><span>{event.type}</span><div><strong>{data.cases.find((item) => item.id === event.requestId)?.name ?? event.requestId}</strong><p>{displayAmount(event.amount, data.policy.resources.find((item) => item.id === event.resourceId)?.unit ?? "units")} · {event.note}</p></div><time>{new Date(event.createdAt).toLocaleString()}</time></article>)}{!data.ledger.length && <p className="empty-state">No capacity has been committed. Reconcile an allocated request or ask an agent to reserve capacity.</p>}</div></section></div>}
        {activeTab === "executions" && <div className="stack">{formError && <p className="form-error" role="alert">{formError}</p>}<ExternalExecutionList workspace={data} executions={data.executions} cases={data.cases} policy={data.policy} operatorReady={operatorReady} executionBusy={operatorExecutionBusy} onReview={(execution) => { setFormError(""); setExternalReviewId(execution.id); }} onExecute={approveAndExecuteWithOperator} onRevoke={(execution) => { setFormError(""); setExternalRevokeId(execution.id); }} /></div>}
        {activeTab === "activity" && <section className="canvas-card workspace-card"><div className="section-heading"><div><span className="eyebrow">Activity log</span><h2>Visible and attributable</h2></div><span className="quiet">{latestUndoLocked ? "Execution evidence locks earlier policy inputs; create a new revision instead" : "Policy inputs are reversible · saved history and execution are retained"}</span></div><div className="full-activity">{data.activity.map((item) => { const canUndo = item.id === latestUndoId; return <article key={item.id}><span className={`actor ${item.actor}`}>{item.actor === "human" ? "HU" : item.actor === "agent" ? "AI" : "EN"}</span><div><strong>{item.action}</strong><p>{item.detail}</p><small>{item.actor} · {timeAgo(item.createdAt)}</small></div>{canUndo && (latestUndoLocked ? <span className="undo-locked" title="Execution evidence is retained">Undo locked</span> : <button type="button" onClick={() => undo(item)}>Undo</button>)}</article>; })}</div></section>}
        {activeTab === "versions" && <ImpactReportList reports={data.impactReports} policy={data.policy} onExport={shareImpactReport} />}
        {guestMode && activeTab !== "operator" && <div className="agent-quickstart-mobile"><AgentQuickstart compact steps={activeAgentWorkflowSteps} status={webMCPStatus} copiedPromptId={copiedPromptId} onCopy={copyAgentPrompt} requiresApproval={activeGovernancePolicy.requireApproval} /></div>}
      </section>
      {assistantOpen && !assistantCompact && <aside id="workspace-assistant" className="assistant-dock">{assistantContent}</aside>}
    </div>

    {assistantOpen && assistantCompact && <Modal title="Policy assistant" onClose={() => setAssistantOpen(false)}><div id="workspace-assistant" className="assistant-mobile">{assistantContent}</div></Modal>}
    {assistantEvidenceOpen && operatorResult && <Modal title="Assistant evidence" onClose={() => { setAssistantEvidenceOpen(false); if (assistantCompact) setAssistantOpen(true); }}>{assistantStale && <p className="form-note">Historical results: workspace inputs have changed. Run another review for current decisions.</p>}<AssistantEvidence result={operatorResult} /></Modal>}
    {libraryOpen && <Modal title="Policy template library" onClose={() => setLibraryOpen(false)}><div className="preset-grid">{simulationPresets.map((preset) => <article key={preset.id} className={`schema:${preset.id}` === data.presetId ? "active" : ""}><span className="eyebrow">{preset.category}</span><h3>{preset.title}</h3><p>{preset.description}</p><small>{preset.capability} · structure only · no capacity, reserve, rate window, rules, requests, or assignments</small><button className="button secondary" type="button" aria-label={`Use ${preset.title} policy template`} onClick={() => choosePreset(preset)}>Use template</button></article>)}</div></Modal>}
    {pendingPreset && <Modal title="Replace policy structure?" onClose={() => setPendingPreset(null)}><div className="confirmation-copy"><p><strong>{pendingPreset.title}</strong> will replace typed fields, resource identity, ranking structure, and allocation strategy. Capacity, reserve, rate window, rule thresholds, requests, and assignments will be cleared. Your current workspace remains available through Undo.</p><div className="form-actions"><button className="button secondary" type="button" onClick={() => setPendingPreset(null)}>Cancel</button><button className="button primary" type="button" onClick={() => installPreset(pendingPreset)}>Replace schema</button></div></div></Modal>}
    {leaveConfirmationOpen && <Modal title="Exit local session?" onClose={() => setLeaveConfirmationOpen(false)}><div className="confirmation-copy"><p>This session exists only in this browser tab. Sign in to retain it, or export its policy, requests, reports, allocations, and ledger as an audit file before exiting.</p><div className="leave-actions"><button className="button secondary" type="button" onClick={() => setLeaveConfirmationOpen(false)}>Continue working</button>{!needsConfiguration && <button className="button secondary" type="button" onClick={exportAuditFile}>Export audit file</button>}<button className="button danger" type="button" onClick={() => void handleSignOut()}>Exit and discard</button></div></div></Modal>}
    {pendingRemoval && <Modal title="Confirm rule removal" onClose={() => setPendingRemoval(null)}><div className="confirmation-copy">{formError && <p className="form-error">{formError}</p>}<p><strong>{pendingRemoval.id} · {pendingRemoval.label}</strong> remains active until you confirm. Removing it can change outcomes and every resource allocation.</p><div className="form-actions"><button className="button secondary" type="button" onClick={() => setPendingRemoval(null)}>Keep rule</button><button className="button danger" type="button" onClick={confirmRemoval}>Remove rule</button></div></div></Modal>}
    {pendingCaseRemoval && <Modal title="Confirm request removal" onClose={() => { setPendingCaseRemoval(null); setFormError(""); }}><div className="confirmation-copy">{formError && <p className="form-error">{formError}</p>}<p><strong>{pendingCaseRemoval.id} · {pendingCaseRemoval.name}</strong> remains in the current simulation until you confirm. Requests with ledger history cannot be removed.</p><div className="form-actions"><button className="button secondary" type="button" onClick={() => { setPendingCaseRemoval(null); setFormError(""); }}>Keep request</button><button className="button danger" type="button" onClick={confirmCaseRemoval}>Remove request</button></div></div></Modal>}
    {editor && !pendingRemoval && !pendingCaseRemoval && <Modal title={editor === "definition" ? "Define decision policy" : editor === "policy" ? "Policy settings & schema" : editor === "case" ? editingCase ? `Edit ${editingCase.id}` : "Add request" : editor === "version" ? "Save full policy version" : editor === "reconcile" ? "Reconcile request usage" : editingRule ? `Edit ${editingRule.id}` : "Add policy rule"} onClose={() => { setEditor(null); setEditingRule(null); setEditingCase(null); setFormError(""); }}>
      {editor === "definition" && <form onSubmit={submitDefinition} className="definition-form">
        {formError && <p className="form-error">{formError}</p>}
        <section><div><span className="step-number">01</span><div><strong>Scope</strong><p>State what this policy decides and the outcome it is trying to produce.</p></div></div><div className="definition-fields"><label>Program name<input name="name" required maxLength={100} defaultValue={isBlankWorkspace ? "" : data.policy.name} /></label><label className="full">Objective<textarea name="objective" required maxLength={300} defaultValue={isBlankWorkspace ? "" : data.policy.objective} /></label></div></section>
        <section><div><span className="step-number">02</span><div><strong>Eligibility</strong><p>Define when a failed request is close enough for human review.</p></div></div><div className="definition-fields"><label>Tolerance (%)<input name="boundaryTolerance" type="number" required min="0" max="100" step="1" defaultValue={needsConfiguration ? "" : Math.round(activeBoundaryPolicy.tolerance * 100)} /></label><label>Maximum failed gates<input name="maximumFailedRules" type="number" required min="0" max="10" step="1" defaultValue={needsConfiguration ? "" : activeBoundaryPolicy.maximumFailedRules} /></label><p className="definition-summary full">{countNoun(data.rules.filter((rule) => rule.enabled && rule.kind === "threshold").length, "enabled eligibility gate")}. Edit individual gate logic on the policy canvas.</p></div></section>
        <section><div><span className="step-number">03</span><div><strong>Priority</strong><p>Set the score range and verify the deterministic tie-break order.</p></div></div><div className="definition-fields three"><label>Base score<input name="baseScore" type="number" required defaultValue={needsConfiguration ? "" : activeScoringPolicy.base} /></label><label>Minimum<input name="minimumScore" type="number" required defaultValue={needsConfiguration ? "" : activeScoringPolicy.minimum} /></label><label>Maximum<input name="maximumScore" type="number" required defaultValue={needsConfiguration ? "" : activeScoringPolicy.maximum} /></label><div className="ranking-summary full">{data.policy.ranking.map((item, index) => <span key={`${item.source}:${item.key}:${index}`}>{index + 1}. {rankingCriterionLabel(item, data.policy)}</span>)}</div></div></section>
        <section><div><span className="step-number">04</span><div><strong>Limits</strong><p>Set the primary resource envelope, protected reserve, and allocation strategy.</p></div></div><div className="definition-fields three"><label>Resource label<input name="resourceLabel" required maxLength={80} defaultValue={isBlankWorkspace ? "" : mainResource.label} /></label><label>Unit<input name="unit" required maxLength={30} defaultValue={isBlankWorkspace ? "" : mainResource.unit} /></label><label>Capacity{!isBlankWorkspace ? ` (${mainResource.unit})` : ""}<input name="capacity" type="number" required min="0" max="100000000" step={resourceStrategyDraft === "slot" || resourceStrategyDraft === "rate_limit" || (!isBlankWorkspace && !mainResource.divisible) ? 1 : "any"} defaultValue={needsConfiguration ? "" : mainResource.capacity} /></label><label>Protected reserve{!isBlankWorkspace ? ` (${mainResource.unit})` : ""}<input name="reserve" type="number" required min="0" max="100000000" step={resourceStrategyDraft === "slot" || resourceStrategyDraft === "rate_limit" || (!isBlankWorkspace && !mainResource.divisible) ? 1 : "any"} defaultValue={needsConfiguration ? "" : mainResource.reserve} /></label><label>Strategy<select name="strategy" required value={isBlankWorkspace && !resourceStrategyDraft ? "" : resourceStrategyDraft} onChange={(event) => setResourceStrategyDraft(event.target.value as AllocationStrategy)}>{isBlankWorkspace && <option value="" disabled>Select strategy</option>}{Object.entries(allocationStrategyLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>{resourceStrategyDraft === "rate_limit" && <label>Rate window (hours)<input name="windowHours" type="number" required min="0.000278" max="8760" step="any" defaultValue={needsConfiguration ? "" : (mainResource.windowSeconds ?? 0) / 3_600 || ""} /><small className="field-help">Calls counted inside this rolling window reduce available quota.</small></label>}{resourceStrategyDraft === "slot" || resourceStrategyDraft === "rate_limit" ? <p className="definition-summary">{resourceStrategyDraft === "slot" ? "Slot assignment" : "Rate-window quota"} uses whole {isBlankWorkspace ? "resource units" : mainResource.unit}; fractional allocation is disabled.</p> : <label className="checkbox-label"><input name="divisible" type="checkbox" defaultChecked={isBlankWorkspace ? false : mainResource.divisible} />Allow fractional allocation</label>}</div></section>
        <section><div><span className="step-number">05</span><div><strong>Governance</strong><p>Name the accountable owner, lifecycle, and execution checkpoint.</p></div></div><div className="definition-fields"><label>Policy owner<input name="owner" required maxLength={100} defaultValue={needsConfiguration ? "" : activeGovernancePolicy.owner} /></label><label>Status<select name="status" required defaultValue={needsConfiguration ? "" : activeGovernancePolicy.status}>{needsConfiguration && <option value="" disabled>Select status</option>}<option value="draft">Draft</option><option value="active">Active</option><option value="retired">Retired</option></select></label><label>Effective from<input name="effectiveFrom" type="date" defaultValue={activeGovernancePolicy.effectiveFrom?.slice(0, 10) ?? ""} /></label><label>Effective until<input name="effectiveUntil" type="date" defaultValue={activeGovernancePolicy.effectiveUntil?.slice(0, 10) ?? ""} /></label><label className="checkbox-label"><input name="requireApproval" type="checkbox" defaultChecked={activeGovernancePolicy.requireApproval} />Require human approval for budget grants, agent changes and external actions</label><label className="checkbox-label"><input name="requireRationale" type="checkbox" defaultChecked={activeGovernancePolicy.requireRationale} />Require rationale in versions</label></div><p className="form-note">When human approval is off, only eligible, allocated actions matching the active policy can be authorized automatically. Denied, boundary, review, stale, or unmatched actions remain blocked.</p></section>
        <p className="form-note">Requests and rule logic stay fixed while this definition flows through eligibility, boundary classification, scoring, ranking, and allocation.</p><FormActions onCancel={() => setEditor(null)} label="Save definition" />
      </form>}
      {editor === "policy" && <form onSubmit={submitPolicy} className="form-grid">{formError && <p className="form-error full">{formError}</p>}<label className="full">Program name<input name="name" required maxLength={100} defaultValue={data.policy.name} /></label><label className="full">Objective<textarea name="objective" required maxLength={300} defaultValue={data.policy.objective} /></label><label>Resource label<input name="resourceLabel" required maxLength={80} defaultValue={mainResource.label} /></label><label>Unit<input name="unit" required maxLength={30} defaultValue={mainResource.unit} /></label><label>Capacity ({mainResource.unit})<input name="capacity" type="number" required min="0" max="100000000" step={resourceStrategyDraft === "slot" || resourceStrategyDraft === "rate_limit" || !mainResource.divisible ? 1 : "any"} defaultValue={mainResource.capacity} /></label><label>Protected reserve ({mainResource.unit})<input name="reserve" type="number" required min="0" max="100000000" step={resourceStrategyDraft === "slot" || resourceStrategyDraft === "rate_limit" || !mainResource.divisible ? 1 : "any"} defaultValue={mainResource.reserve} /></label><label>Strategy<select name="strategy" value={resourceStrategyDraft} onChange={(event) => setResourceStrategyDraft(event.target.value as AllocationStrategy)}>{Object.entries(allocationStrategyLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>{resourceStrategyDraft === "rate_limit" && <label>Rate window (hours)<input name="windowHours" type="number" required min="0.000278" max="8760" step="any" defaultValue={(mainResource.windowSeconds ?? 0) / 3_600 || ""} /><small className="field-help">Calls counted inside this rolling window reduce available quota.</small></label>}{resourceStrategyDraft === "slot" || resourceStrategyDraft === "rate_limit" ? <p className="definition-summary">{resourceStrategyDraft === "slot" ? "Slot assignment" : "Rate-window quota"} uses whole {mainResource.unit}; fractional allocation is disabled.</p> : <label className="checkbox-label"><input name="divisible" type="checkbox" defaultChecked={mainResource.divisible} />Allow fractional allocation</label>}<div className="full outcome-fields"><label>Pass label<input name="eligible" required maxLength={40} defaultValue={data.policy.outcomes.eligible} /></label><label>Boundary label<input name="boundary" required maxLength={40} defaultValue={data.policy.outcomes.boundary} /></label><label>Review label<input name="review" required maxLength={40} defaultValue={data.policy.outcomes.review} /></label></div><label className="full">Complete policy schema JSON (optional)<textarea name="schemaJson" rows={7} placeholder='Paste a full Policy JSON object to replace fields, resources, ranking, outcomes, name, and objective.' /></label><label className="checkbox-label full"><input name="resetSchema" type="checkbox" />I understand schema import resets active rules and requests only when no execution evidence exists</label><p className="form-note full">Use the fields above for a safe policy edit. JSON import supports a completely new multi-resource policy before ledger or external-action evidence exists.</p><FormActions onCancel={() => setEditor(null)} label="Save policy" /></form>}
      {editor === "rule" && <form onSubmit={submitRule} className="form-grid rule-form">
        {formError && <p className="form-error full">{formError}</p>}
        <label>Rule label<input name="label" required maxLength={80} defaultValue={editingRule?.label ?? ""} placeholder="What does this rule do?" /></label>
        <label>Rule kind<select name="kind" value={ruleFormKind} onChange={(event) => setRuleFormKind(event.target.value as RuleKind)}><option value="threshold">Eligibility threshold</option><option value="score">Score adjustment</option><option value="outcome">Outcome override</option><option value="cap">Allocation cap</option></select></label>
        <label>Field<select name="field" value={ruleFormField} onChange={(event) => { const field = event.target.value; const definition = data.policy.fields.find((item) => item.key === field); setRuleFormField(field); setRuleFormOperator(definition?.type === "enum" || definition?.type === "boolean" ? "eq" : "gte"); }}>{data.policy.fields.map((field) => <option value={field.key} key={field.key}>{field.label}</option>)}{data.policy.resources.map((resource) => <option value={`demand:${resource.id}`} key={`demand:${resource.id}`}>{resource.label} request</option>)}</select></label>
        <label>Comparison<select name="operator" value={ruleFormOperator} onChange={(event) => setRuleFormOperator(event.target.value as Operator)}>{ruleOperators(selectedRuleField).map((operator) => <option value={operator} key={operator}>{operatorLabel(operator)}</option>)}</select></label>
        <label>Comparison value{selectedRuleField?.type === "boolean" && (ruleFormOperator === "eq" || ruleFormOperator === "neq") ? <select name="value" defaultValue={String(editingRule?.conditions[0]?.value ?? "true")}><option value="true">Yes</option><option value="false">No</option></select> : selectedRuleField?.type === "enum" && (ruleFormOperator === "eq" || ruleFormOperator === "neq") ? <select name="value" defaultValue={String(editingRule?.conditions[0]?.value ?? selectedRuleField.options?.[0] ?? "")}>{selectedRuleField.options?.map((option) => <option value={option} key={option}>{humanizeOption(option)}</option>)}</select> : <input name="value" required inputMode={selectedRuleField?.type === "number" || selectedRuleField?.type === "integer" || !selectedRuleField ? "decimal" : undefined} defaultValue={Array.isArray(editingRule?.conditions[0]?.value) ? editingRule.conditions[0].value.join(", ") : String(editingRule?.conditions[0]?.value ?? "")} placeholder={ruleFormOperator === "between" ? "Minimum, maximum" : ruleFormOperator === "in" || ruleFormOperator === "not_in" ? "Comma-separated values" : "Comparison value"} />}{selectedRuleValueHint && <small className="field-help">{selectedRuleValueHint}</small>}</label>
        {ruleFormKind === "score" && <label>Score points<input name="points" type="number" required min="-100" max="100" defaultValue={editingRule?.kind === "score" ? editingRule.points : 10} /></label>}
        {ruleFormKind === "outcome" && <label>Override outcome<select name="result" defaultValue={editingRule?.result ?? "review"}><option value="eligible">{data.policy.outcomes.eligible}</option><option value="boundary">{data.policy.outcomes.boundary}</option><option value="review">{data.policy.outcomes.review}</option></select></label>}
        {ruleFormKind === "cap" && <><label>Resource to cap<select name="resourceId" defaultValue={editingRule?.resourceId ?? mainResource.id}>{data.policy.resources.map((resource) => <option value={resource.id} key={resource.id}>{resource.label}</option>)}</select></label><label>Maximum allocation ({(data.policy.resources.find((resource) => resource.id === (editingRule?.resourceId ?? mainResource.id)) ?? mainResource).unit})<input name="amount" type="number" required min="0" step={resourceRequiresWholeUnits(data.policy.resources.find((resource) => resource.id === (editingRule?.resourceId ?? mainResource.id)) ?? mainResource) ? 1 : "any"} defaultValue={editingRule?.kind === "cap" ? editingRule.amount : 0} /></label></>}
        <label>Rule priority<input name="priority" type="number" min="0" max="1000" defaultValue={editingRule?.priority ?? 0} /><small className="field-help">Higher-priority rules run first.</small></label>
        <p className="form-note full">Only controls relevant to the selected rule kind are shown. Use commas for “between” and membership comparisons. WebMCP can create bounded AND/OR compound rules.</p>
        <FormActions onCancel={() => { setEditor(null); setEditingRule(null); }} label={editingRule ? "Save rule" : "Add rule"} />
      </form>}
      {editor === "case" && <form onSubmit={submitCase} className="form-grid">{formError && <p className="form-error full">{formError}</p>}<label className="full">Request name<input name="name" required maxLength={100} defaultValue={editingCase?.name ?? ""} /></label><label className="full">Optional group<input name="group" maxLength={80} placeholder="Team, district, or cohort" defaultValue={editingCase?.group ?? ""} /></label>{data.policy.fields.map((field) => <DynamicField key={field.key} field={field} value={editingCase?.values[field.key]} />)}{data.policy.resources.map((resource) => <div className="resource-inputs full" key={resource.id}><label>{resource.label} demand ({resource.unit})<input name={`demand:${resource.id}`} type="number" required min="0" step={resourceRequiresWholeUnits(resource) ? 1 : "any"} defaultValue={editingCase ? editingCase.demands[resource.id] : ""} /></label><label>Minimum useful allocation ({resource.unit})<input name={`minimum:${resource.id}`} type="number" required min="0" step={resourceRequiresWholeUnits(resource) ? 1 : "any"} defaultValue={editingCase ? editingCase.minimums[resource.id] : ""} /></label></div>)}<p className="form-note full">Use non-sensitive request inputs. RuleRipple evaluates declared policy; external MCP actions require separate connected-tool calls and either the configured human checkpoint or explicit policy authorization.</p><FormActions onCancel={() => { setEditor(null); setEditingCase(null); }} label={editingCase ? "Save request" : "Add request"} /></form>}
      {editor === "version" && <form onSubmit={submitVersion} className="form-grid">{formError && <p className="form-error full">{formError}</p>}<label className="full">Version label<input name="label" required maxLength={60} defaultValue={`Version ${data.versions.length + 1}`} /></label><label className="full">Rationale {activeGovernancePolicy.requireRationale ? "(required by policy)" : "(optional)"}<textarea name="rationale" required={activeGovernancePolicy.requireRationale} maxLength={240} /></label><FormActions onCancel={() => setEditor(null)} label="Save snapshot" /></form>}
      {editor === "reconcile" && selectedCase && selectedAllocation && reconciliationAllocation && <form onSubmit={submitReconciliation} className="form-grid">{formError && <p className="form-error full">{formError}</p>}<p className="form-note full">Enter the <strong>confirmed total usage</strong> for <strong>{selectedCase.name}</strong>. RuleRipple will account for existing reservations or external-action commitments, consume the confirmed amount, and release the unused remainder. No usage value is assumed.</p><label>Resource<select name="resourceId" value={reconciliationResource.id} onChange={(event) => setReconciliationResourceId(event.target.value)}>{reconciliationResources.map((resource) => <option value={resource.id} key={resource.id}>{resource.label} · {displayAmount(reconciliationAmounts[resource.id], resource.unit)} available for reconciliation</option>)}</select></label><label>Total confirmed usage<input key={reconciliationResource.id} name="actualUsage" type="number" required min="0" max={reconciliationAllocation.allocated} step={resourceRequiresWholeUnits(reconciliationResource) ? 1 : "any"} placeholder={`0 to ${reconciliationAllocation.allocated}`} /></label>{reconciliationLedgerState && reconciliationLedgerState.reserved + reconciliationLedgerState.committed > 0 && <p className="form-note full">Outstanding execution evidence: {displayAmount(reconciliationLedgerState.reserved, reconciliationResource.unit)} reserved and {displayAmount(reconciliationLedgerState.committed, reconciliationResource.unit)} committed. This reconciliation closes those outstanding amounts against the confirmed total.</p>}<FormActions onCancel={() => setEditor(null)} label="Confirm usage" /></form>}
    </Modal>}
    {pendingPolicyChange && pendingProposalComparison && <PendingProposalReview proposal={pendingPolicyChange} comparison={pendingProposalComparison} policy={pendingPolicyChange.candidate.policy} error={formError} onApprove={approvePendingPolicyProposal} onReject={rejectPendingPolicyProposal} />}
    {pendingExecutionChange && <PendingExecutionReview proposal={pendingExecutionChange} error={formError} onApprove={approvePendingExecutionProposal} onReject={rejectPendingExecutionProposal} />}
    {pendingExternalExecution && <PendingExternalExecutionReview execution={pendingExternalExecution} policy={data.policy} stale={!executionPolicyIsCurrent(data, pendingExternalExecution)} request={data.cases.find((item) => item.id === pendingExternalExecution.requestId)} error={formError} operatorReady={operatorReady} executionBusy={operatorExecutionBusy === pendingExternalExecution.id} onClose={() => { setExternalReviewId(null); setFormError(""); }} onApprove={() => approvePendingExternalExecution(pendingExternalExecution)} onApproveAndExecute={() => approveAndExecuteWithOperator(pendingExternalExecution)} onReject={() => rejectPendingExternalExecution(pendingExternalExecution)} />}
    {approvedExternalExecutionToRevoke && <Modal title="Revoke external approval?" onClose={() => { setExternalRevokeId(null); setFormError(""); }}><div className="confirmation-copy">{formError && <p className="form-error">{formError}</p>}<p><strong>{approvedExternalExecutionToRevoke.id} · {EXTERNAL_ACTIONS[approvedExternalExecutionToRevoke.actionId].label}</strong> is approved and its policy capacity is reserved. Revoke only if no connected operator or external agent has invoked GitHub. This releases the reservation and appends a cancellation to the audit ledger.</p><div className="form-actions"><button className="button secondary" type="button" onClick={() => { setExternalRevokeId(null); setFormError(""); }}>Keep approval</button><button className="button danger" type="button" onClick={() => revokeApprovedExternalExecution(approvedExternalExecutionToRevoke)}>Revoke and release</button></div></div></Modal>}
  </main>;
}

function operatorFieldHint(field: FieldDefinition) {
  if (field.type === "boolean") return "yes or no";
  if (field.type === "enum") return field.options?.join(" | ") ?? "configured option";
  if (field.min !== undefined || field.max !== undefined) return `${field.min ?? "number"}–${field.max ?? "number"}`;
  return field.type === "integer" ? "whole number" : "number";
}

function ConnectionsPanel({ status, signedIn, policy, data, busy, refreshing, onRefresh, error, onDisconnect, onAssistant }: { status: OperatorConnectionStatus | null; signedIn: boolean; policy: Policy; data: WorkspaceData; busy: boolean; refreshing: boolean; onRefresh: () => void; error: string; onDisconnect: () => void; onAssistant: () => void; }) {
  const resource = primaryResource(policy);
  const requiresApproval = governancePolicy(policy).requireApproval;
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [intakeCopied, setIntakeCopied] = useState(false);
  const intakeTemplate = ["## Policy intake", "", ...policy.fields.map((field) => `- ${field.label}: <${operatorFieldHint(field)}>`), `- ${resource.label} demand: <${resource.unit}>`, `- Minimum useful allocation: <${resource.unit}>`].join("\n");
  const { batchReady, reviewReady, issue: setupIssue, githubLabel } = operatorReadiness(status, signedIn);
  return <div className="stack operator-workspace">
    <section id="operator-connections" className="canvas-card workspace-card operator-connection">
      <div className="section-heading"><div><span className="eyebrow">Connections</span><h2>Connected services</h2></div><span className={`operator-ready-state ${batchReady ? "ready" : "waiting"}`}>{batchReady ? "GitHub actions ready" : "Setup required"}</span></div>
      <div className="connection-services"><article><div className="connection-service-title"><span className="connector-logo github"><Image src="/connectors/github.svg" width={24} height={24} alt="" /></span><h3>GitHub</h3><span className={batchReady ? "connection-state ready" : "connection-state"}>{batchReady ? "Ready" : githubLabel}</span></div><p>Verify source evidence and execute an authorized, exact-SHA pull-request merge.</p><strong>{status?.connected ? status.account?.login ?? "Connected account" : "Connect your account below"}</strong><small>Exact action arguments and policy version remain pinned.</small></article><article><div className="connection-service-title"><span className="assistant-mark"><AssistantIcon /></span><h3>Policy assistant</h3><span className={reviewReady ? "connection-state ready" : "connection-state"}>{reviewReady ? "Ready" : "Setup required"}</span></div><p>Ask questions without leaving your work. The policy engine calculates the results; the assistant explains them.</p><strong>{status?.model_configured ? status.model : "Model not configured"}</strong><small>Credentials stay on the server. GitHub is not needed for read-only review.</small><button className="button primary" type="button" onClick={onAssistant}>Open assistant</button></article></div><p className="form-note">Current governance: <strong>{requiresApproval ? "Human approval required" : "Policy-authorized automation"}</strong>.</p>

      {setupIssue && <p className="operator-setup-note">{setupIssue}</p>}
      <div className="operator-connection-actions">{status?.operator_access && status.oauth_configured && !status.connected && <a className="button primary" href="/api/github/connect">Connect GitHub</a>}{signedIn && <button className="button secondary" type="button" disabled={busy || refreshing} onClick={onRefresh}>{refreshing ? "Checking connections…" : "Check connections"}</button>}{status?.connected && <button className="button secondary" type="button" disabled={busy || refreshing} onClick={() => setConfirmDisconnect(true)}>Disconnect GitHub</button>}{status?.account?.htmlUrl && <a className="text-link" href={status.account.htmlUrl} target="_blank" rel="noreferrer">Open connected account ↗</a>}</div>
      {confirmDisconnect && <div className="inbox-notice" role="alert"><p>Disconnect GitHub? New source checks and executions will stop. Saved requests and receipts remain.</p><div className="operator-connection-actions"><button className="button secondary" type="button" disabled={busy || refreshing} onClick={() => setConfirmDisconnect(false)}>Keep connected</button><button className="button danger" type="button" disabled={busy || refreshing} onClick={() => { setConfirmDisconnect(false); onDisconnect(); }}>Confirm disconnect</button></div></div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!status?.connected && <p className="form-note">GitHub access is requested for public repositories and basic account identity. Disconnect at any time.</p>}
    </section>
    <details className="canvas-card workspace-card connection-intake" open><summary>Agent intake & credentials</summary><p>One-time setup for each worker. Connected agents then send their own requests into the shared inbox.</p><AgentConnectionsPanel data={data} signedIn={signedIn} /><IntakeContract data={data} /></details>
    <section id="operator-intake" className="case-card workspace-card operator-intake">
      <details><summary>Required pull-request intake for this policy</summary><p>Paste exactly one dedicated section into the pull-request description and replace every bracketed value. RuleRipple ignores text outside the section and rejects missing, duplicate, unknown, or invalid declarations.</p><div className="operator-intake-template-head"><strong>Exact Markdown structure</strong><button type="button" onClick={() => { void copyText(intakeTemplate).then(() => { setIntakeCopied(true); window.setTimeout(() => setIntakeCopied(false), 2200); }).catch(() => setIntakeCopied(false)); }}>{intakeCopied ? "Copied" : "Copy template"}</button></div><pre className="operator-intake-template"><code>{intakeTemplate}</code></pre><div className="operator-intake-fields">{policy.fields.map((field) => <span key={field.key}><strong>{field.label}</strong><small>{operatorFieldHint(field)}</small></span>)}<span><strong>{resource.label} demand</strong><small>{resource.unit}</small></span><span><strong>Minimum useful allocation</strong><small>{resource.unit}</small></span></div></details>
    </section>
    <details className="canvas-card workspace-card connection-roadmap"><summary>Other systems · not yet built in</summary><p>The intake contract accepts requests from any authorized worker. Native action adapters for these systems are not available yet.</p><div className="planned-connectors">{[["jira", "Jira"], ["slack", "Slack"], ["microsoft-teams", "Microsoft Teams"]].map(([icon, name]) => <span key={icon}><Image src={`/connectors/${icon}.svg`} width={20} height={20} alt="" />{name}<small>Planned</small></span>)}</div><p>Each future action adapter requires scoped authentication, typed arguments, authorization checks, and an attributable receipt.</p></details>
  </div>;
}
function PolicyDefinitionOverview({ policy, rules, audit, onEdit }: { policy: Policy; rules: PolicyRule[]; audit: PolicyAuditIssue[]; onEdit: () => void; }) {
  const resource = primaryResource(policy), boundary = boundaryPolicy(policy), scoring = scoringPolicy(policy), governance = governancePolicy(policy); const enabled = rules.filter((rule) => rule.enabled); const thresholds = enabled.filter((rule) => rule.kind === "threshold").length, scoreRules = enabled.filter((rule) => rule.kind === "score").length, caps = enabled.filter((rule) => rule.kind === "cap").length; const errors = audit.filter((item) => item.severity === "error").length, warnings = audit.filter((item) => item.severity === "warning").length; const health = errors ? "Needs fixes" : warnings ? "Review warnings" : "Ready to simulate";
  return <section className="policy-definition"><div className="policy-definition-head"><div><span className="eyebrow">Policy definition</span><h2>Policy at a glance</h2><p>Scope → eligibility → priority → limits → governance</p></div><div className="policy-health"><span className={errors ? "health-error" : warnings ? "health-warning" : "health-ready"}>{health}</span><button className="button secondary" type="button" onClick={onEdit}>Edit definition</button></div></div><div className="definition-grid"><article><span>01 · Scope</span><strong>{policy.name}</strong><p>{governance.owner} · {governance.status}</p></article><article><span>02 · Eligibility</span><strong>{countNoun(thresholds, "enabled gate")}</strong><p>Boundary: ≤ {countNoun(boundary.maximumFailedRules, "failure")} within {Math.round(boundary.tolerance * 100)}%</p></article><article><span>03 · Priority</span><strong>{countNoun(scoreRules, "score rule")}</strong><p>Base {scoring.base} · {countNoun(policy.ranking.length, "ranking criterion", "ranking criteria")}</p></article><article><span>04 · Limits</span><strong>{countNoun(caps, "cap")} · {countNoun(policy.resources.length, "pool")}</strong><p>{allocationStrategyLabels[resource.strategy]} · {displayAmount(resource.reserve, resource.unit)} protected{resource.strategy === "rate_limit" ? ` · resets every ${formatRateWindow(resource.windowSeconds)}` : ""}</p></article><article><span>05 · Governance</span><strong>{governance.requireApproval ? "Human checkpoint" : "Policy-authorized automation"}</strong><p>{governance.requireRationale ? "Rationale required" : "Rationale optional"}{governance.effectiveUntil ? ` · until ${governance.effectiveUntil}` : ""}</p></article></div>{audit.length > 0 && <div className="policy-audit"><div><strong>{countNoun(errors, "error")} · {countNoun(warnings, "warning")}</strong><span>Automatic policy checks</span></div><ul>{audit.slice(0, 4).map((issue) => <li className={issue.severity} key={`${issue.code}:${issue.ruleIds?.join(":") ?? "policy"}`}><span>{issue.severity === "error" ? "×" : "!"}</span>{issue.message}</li>)}{audit.length > 4 && <li className="more"><span>+</span>{countNoun(audit.length - 4, "additional check")}</li>}</ul></div>}</section>;
}

function DynamicField({ field, value }: { field: FieldDefinition; value?: FieldValue }) {
  if (field.type === "enum") return <label>{field.label}<select name={`field:${field.key}`} required defaultValue={typeof value === "string" ? value : ""}>{value === undefined && <option value="" disabled>Select {field.label.toLowerCase()}</option>}{field.options?.map((option) => <option value={option} key={option}>{humanizeOption(option)}</option>)}</select></label>;
  if (field.type === "boolean") return <label>{field.label}<select name={`field:${field.key}`} required defaultValue={typeof value === "boolean" ? String(value) : ""}>{value === undefined && <option value="" disabled>Select yes or no</option>}<option value="true">Yes</option><option value="false">No</option></select></label>;
  const range = field.min !== undefined && field.max !== undefined ? ` (${field.min}–${field.max}${field.unit ? ` ${field.unit}` : ""})` : field.unit ? ` (${field.unit})` : "";
  return <label>{field.label}{range}<input name={`field:${field.key}`} type="number" required min={field.min} max={field.max} step={field.type === "integer" ? 1 : "any"} defaultValue={typeof value === "number" ? value : undefined} /></label>;
}

function AgentQuickstart({ steps, status, copiedPromptId, onCopy, requiresApproval, compact = false }: { steps: readonly AgentWorkflowStep[]; status: WebMCPStatus; copiedPromptId: string | null; onCopy: (step: AgentWorkflowStep) => Promise<void>; requiresApproval: boolean; compact?: boolean }) {
  const titleId = useId();
  const state = {
    ready: { label: "WebMCP ready", tone: "ready" }, checking: { label: "Connecting", tone: "checking" }, unavailable: { label: "WebMCP unavailable", tone: "unavailable" },
    blocked: { label: "Top-level page required", tone: "blocked" }, error: { label: "Refresh to retry", tone: "error" }, "signed-out": { label: "Sign in required", tone: "unavailable" },
  }[status];
  const content = <>
    <div className="agent-quickstart-head"><div><span className="eyebrow">Agent workflow</span><h2 id={titleId}>Work with RuleRipple through WebMCP</h2></div><span className={`agent-ready-state ${state.tone}`}><span />{state.label}</span></div>
    <p className="agent-quickstart-intro">Use these prompts as a starting point, or ask your agent to inspect, simulate, propose, execute approved external work, record evidence, and reconcile reported usage through the 19 governed tools.</p>
    <div className="agent-prompt-list">{steps.map((step) => <article key={step.id}><div className="agent-prompt-label"><span>{step.number}</span><strong>{step.title}</strong></div><p>{step.prompt}</p><button type="button" onClick={() => void onCopy(step)} aria-label={`Copy ${step.title.toLowerCase()} agent prompt`}>{copiedPromptId === step.id ? "Copied" : "Copy prompt"}</button></article>)}</div>
    <p className="agent-quickstart-note"><strong>Agents propose. RuleRipple calculates. The policy controls authorization.</strong> {requiresApproval ? "Changes and external actions wait for human review." : "Eligible, allocated external actions can proceed through explicit policy authorization."}</p>
  </>;
  if (compact) return <details className="agent-quickstart agent-quickstart-compact"><summary><span><span className="eyebrow">Try with your agent</span><strong>Run the {steps.length}-step WebMCP workflow</strong></span><span className={`agent-ready-state ${state.tone}`}><span />{state.label}</span></summary><div className="agent-quickstart-body" aria-labelledby={titleId}>{content}</div></details>;
  return <section className="agent-quickstart" aria-labelledby={titleId}>{content}</section>;
}

function AuthScreen({ busy, error, onAuthenticate, onGuest }: { busy: boolean; error: string; onAuthenticate: (mode: "signin" | "signup", email: string, password: string) => Promise<void>; onGuest: () => void; }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); void onAuthenticate(mode, String(form.get("email") ?? "").trim(), String(form.get("password") ?? "")); }
  return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><div className="brand-mark">RR</div><div><strong>RuleRipple</strong><span>Governed decisions for scarce resources</span></div></div><span className="eyebrow">Policy control for humans and agents</span><h1>Let agents propose. See every ripple. Keep humans in control.</h1><p>Turn policy into executable rules, simulate every outcome and allocation, and expose governed workflows through WebMCP—before anything is authorized or executed.</p><div className="auth-proof-grid"><span><strong>19</strong> WebMCP tools</span><span><strong>Deterministic</strong> decision engine</span><span><strong>Configurable</strong> approval</span></div><button className="button primary guest-access-button" type="button" onClick={onGuest}>Open new workspace</button><small className="guest-note">No policy, capacity, rules, requests, or assignments are prefilled</small><div className="auth-divider"><span>or save a private workspace</span></div><div className="auth-tabs" role="group" aria-label="Account access"><button className={mode === "signin" ? "active" : ""} type="button" aria-pressed={mode === "signin"} onClick={() => setMode("signin")}>Sign in</button><button className={mode === "signup" ? "active" : ""} type="button" aria-pressed={mode === "signup"} onClick={() => setMode("signup")}>Create account</button></div><form className="auth-form" onSubmit={submit}>{error && <p className="form-error">{error}</p>}<label>Email<input name="email" type="email" required autoComplete="email" /></label><label>Password<input name="password" type="password" required minLength={6} autoComplete={mode === "signin" ? "current-password" : "new-password"} /></label><button className="button secondary" type="submit" disabled={busy} aria-label={mode === "signin" ? "Sign in to private workspace" : "Create a private workspace account"}>{busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}</button></form><div className="auth-trust"><strong>No service-account key or refresh token in browser JavaScript.</strong><span>A same-origin session gateway reaches Firebase; Firestore rules enforce per-user ownership.</span></div></section></main>;
}
const CloudLoading = ({ label }: { label: string }) => <main className="auth-shell"><section className="auth-card compact"><div className="loading-mark" /><h1>{label}</h1><p>RuleRipple opens after authentication and cloud validation complete.</p></section></main>;
const CloudFailure = ({ message, onRetry, onSignOut }: { message: string; onRetry: () => void; onSignOut: () => void }) => <main className="auth-shell"><section className="auth-card compact"><span className="eyebrow">Safe failure</span><h1>Workspace unavailable</h1><p>{message}</p><div className="auth-actions"><button className="button primary" type="button" onClick={onRetry}>Retry</button><button className="button secondary" type="button" onClick={onSignOut}>Sign out</button></div></section></main>;

function ImpactReportList({ reports, policy, onExport }: { reports: PolicyImpactReport[]; policy: Policy; onExport: (report: PolicyImpactReport) => void }) {
  return <section className="case-card workspace-card impact-reports"><div className="section-heading"><div><span className="eyebrow">Policy impact reports</span><h2>{countNoun(reports.length, "applied change report")}</h2></div><span className="quiet">Durable evidence · UI, JSON, and WebMCP</span></div><div className="impact-report-list">{[...reports].reverse().map((report) => <article key={report.id}><div className="impact-report-head"><div><span>{report.id} · {report.status} · source {report.actor}{report.approvedBy ? ` · approved by ${publicReviewerIdentity(report.approvedBy)}` : ""}</span><strong>{report.label}</strong><p>{report.rationale}</p></div><button className="button secondary" type="button" onClick={() => onExport(report)}>Export report</button></div><div className="impact-report-metrics"><span><strong>{report.outcomeChanges}</strong> {report.outcomeChanges === 1 ? "outcome" : "outcomes"} changed</span><span><strong>{report.rankChanges}</strong> {report.rankChanges === 1 ? "rank" : "ranks"} changed</span><span><strong>{report.allocationChanges}</strong> {report.allocationChanges === 1 ? "allocation" : "allocations"} changed</span><span><strong>{report.affectedCases.length}</strong> affected {report.affectedCases.length === 1 ? "request" : "requests"}</span></div>{report.resources.filter((resource) => Math.abs(resource.before) > 0.000001 || Math.abs(resource.after) > 0.000001 || Math.abs(resource.delta) > 0.000001).map((resource) => { const unit = policy.resources.find((item) => item.id === resource.resourceId)?.unit ?? "units"; return <p className="impact-resource" key={resource.resourceId}>{resource.resourceId}: {displayAmount(resource.before, unit)} → {displayAmount(resource.after, unit)} <strong>{resource.delta > 0 ? "+" : ""}{displayAmount(resource.delta, unit)}</strong></p>; })}<div className="impact-case-list">{report.affectedCases.slice(0, 6).map((item) => { const resourceChanges = item.resources.filter((resource) => Math.abs(resource.delta) > 0.000001).map((resource) => { const unit = policy.resources.find((entry) => entry.id === resource.resourceId)?.unit ?? "units"; return `${resource.resourceId} ${displayAmount(resource.before, unit)} → ${displayAmount(resource.after, unit)}`; }); return <div key={item.caseId}><strong>{item.name}</strong><span>{item.beforeOutcome} → {item.afterOutcome} · rank {item.beforeRank ?? "—"} → {item.afterRank ?? "—"}{resourceChanges.length ? ` · ${resourceChanges.join(" · ")}` : ""}</span></div>; })}{report.affectedCases.length > 6 && <p>+{report.affectedCases.length - 6} more affected requests in the exported report.</p>}</div><small>{report.status === "approved" ? "Approved" : "Applied"} {timeAgo(report.createdAt)} · {report.baselineVersionId ?? "initial state"} → {report.candidateVersionId}</small></article>)}{!reports.length && <p className="empty-state">Apply or approve a simulated policy change to create the first durable impact report.</p>}</div></section>;
}

function PendingProposalReview({ proposal, comparison, policy, error, onApprove, onReject }: { proposal: PendingPolicyChange; comparison: ReturnType<typeof compareSimulationSnapshots>; policy: Policy; error: string; onApprove: () => void; onReject: () => void }) {
  const resource = primaryResource(policy), before = new Map(comparison.beforePortfolio.allocations.map((item) => [item.caseId, item])), after = new Map(comparison.afterPortfolio.allocations.map((item) => [item.caseId, item]));
  const affected = [...new Set([...comparison.changedCases.map((item) => item.testCase.id), ...comparison.changedRanks.map((item) => item.testCase.id), ...comparison.changedAllocations.map((item) => item.testCase.id)])];
  return <Modal title="Review agent policy proposal" onClose={onReject}><div className="proposal-review">{error && <p className="form-error">{error}</p>}<div><span className="eyebrow">{proposal.id} · waiting for human approval</span><h3>{proposal.label}</h3><p>{proposal.detail}</p></div><div className="comparison-summary"><article><span>Inputs changed</span><strong>{comparison.changedRules.length + comparison.changedRequests.length + Number(comparison.policyChanged)}</strong><small>Policy, rules, and requests</small></article><article><span>Outcomes changed</span><strong>{comparison.changedCases.length}</strong><small>Eligibility ripple</small></article><article><span>Allocations changed</span><strong>{comparison.changedAllocations.length}</strong><small>{countNoun(comparison.changedRanks.length, "rank")} changed · portfolio ripple</small></article></div><div className="proposal-deltas">{affected.slice(0, 8).map((caseId) => { const item = proposal.candidate.cases.find((candidate) => candidate.id === caseId) ?? proposal.baseline.cases.find((candidate) => candidate.id === caseId); const beforeAmount = before.get(caseId)?.resources[resource.id]?.allocated ?? 0, afterAmount = after.get(caseId)?.resources[resource.id]?.allocated ?? 0; return <div key={caseId}><strong>{item?.name ?? caseId}</strong><span>{displayAmount(beforeAmount, resource.unit)} → {displayAmount(afterAmount, resource.unit)}</span></div>; })}{!affected.length && <p className="empty-state">The proposal changes policy inputs but has no material effect on the current requests.</p>}</div><p className="form-note">Approving creates an immutable policy version, a first-class impact report, an activity event, and an undo checkpoint. The active policy remains unchanged until approval.</p><div className="form-actions"><button className="button secondary" type="button" onClick={onReject}>Reject proposal</button><button className="button primary" type="button" onClick={onApprove}>Approve &amp; apply</button></div></div></Modal>;
}

function PendingExecutionReview({ proposal, error, onApprove, onReject }: { proposal: PendingExecutionChange; error: string; onApprove: () => void; onReject: () => void }) {
  const beforeLedger = proposal.baseline.ledger.length, afterLedger = proposal.candidate.ledger.length;
  const added = proposal.candidate.ledger.slice(beforeLedger); const resource = proposal.candidate.policy.resources.find((item) => item.id === added[0]?.resourceId); const request = proposal.candidate.cases.find((item) => item.id === added[0]?.requestId);
  return <Modal title="Review agent execution" onClose={onReject}><div className="proposal-review">{error && <p className="form-error">{error}</p>}<div><span className="eyebrow">{proposal.id} · waiting for human approval</span><h3>{proposal.label}</h3><p>{proposal.detail}</p></div><div className="comparison-summary"><article><span>Ledger before</span><strong>{beforeLedger}</strong><small>Confirmed events</small></article><article><span>Events proposed</span><strong>{Math.max(0, afterLedger - beforeLedger)}</strong><small>{ledgerEventSequence(added)}</small></article><article><span>Request</span><strong className="request-reference">{request?.id ?? "—"}</strong><small>{request?.name ?? "No request identified"}</small></article></div><div className="proposal-deltas">{added.map((event) => <div key={event.id}><strong>{event.type}</strong><span>{displayAmount(event.amount, resource?.unit ?? "units")} · {event.note}</span></div>)}{!added.length && <p className="empty-state">This is an idempotent retry; no new ledger event will be created.</p>}</div><p className="form-note">The ledger remains unchanged until you approve. Approval records the agent-originated events and a human-attributed activity entry; rejection records no resource movement.</p><div className="form-actions"><button className="button secondary" type="button" onClick={onReject}>Reject execution</button><button className="button primary" type="button" onClick={onApprove}>Approve execution</button></div></div></Modal>;
}

function githubTargetUrl(execution: ExternalExecution): string | null {
  const fullName = execution.arguments.repository_full_name ?? execution.arguments.repo_full_name, owner = execution.arguments.owner, repo = execution.arguments.repo, issue = execution.arguments.issue_number ?? execution.arguments.pr_number;
  const repository = typeof fullName === "string" ? fullName : typeof owner === "string" && typeof repo === "string" ? `${owner}/${repo}` : null;
  const targetKind = execution.actionId === "github.pull_request.merge" ? "pull" : "issues";
  return repository && typeof issue === "number" ? `https://github.com/${repository}/${targetKind}/${issue}` : null;
}

function externalArgumentText(value: ExternalExecution["arguments"][string]): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function ExternalExecutionList({ workspace, executions, cases, policy, operatorReady, executionBusy, onReview, onExecute, onRevoke }: { workspace: WorkspaceData; executions: ExternalExecution[]; cases: TestCase[]; policy: Policy; operatorReady: boolean; executionBusy: string | null; onReview: (execution: ExternalExecution) => void; onExecute: (execution: ExternalExecution) => void; onRevoke: (execution: ExternalExecution) => void }) {
  const pending = executions.filter((item) => item.status === "pending_approval").length;
  const ready = executions.filter((item) => item.status === "approved").length;
  const completed = executions.filter((item) => item.status === "succeeded" || item.status === "failed").length;
  const labels: Record<ExternalExecution["status"], string> = { pending_approval: "Awaiting human", approved: "Authorized", rejected: "Rejected", cancelled: "Authorization revoked", succeeded: "Succeeded", failed: "Failed" };
  return <div className="stack">
    <section className="canvas-card workspace-card">
      <div className="section-heading"><div><span className="eyebrow">Connected execution loop</span><h2>Policy-gated external actions</h2></div><span className="quiet">Policy check → approval when required → connected tool → receipt</span></div>
      <p className="external-execution-intro">RuleRipple matches the active policy, evaluates the request, and verifies its remaining allocation before an external action can run. When human approval is disabled, an eligible exact action is policy-authorized automatically. GitHub pull-request merge is the currently implemented built-in action. The authorization, exact-argument, receipt, and reconciliation contract is provider-neutral, so Slack, Microsoft Teams, ticketing, cloud, and procurement adapters can use the same controls. External WebMCP agents can use the supported GitHub actions today. Other external action adapters are not connected.</p>
      <div className="ledger-metrics execution-metrics"><article><span>Awaiting review</span><strong>{pending}</strong></article><article><span>Authorized</span><strong>{ready}</strong></article><article><span>Results recorded</span><strong>{completed}</strong></article></div>
    </section>
    <section className="case-card workspace-card">
      <div className="section-heading"><div><span className="eyebrow">Execution evidence</span><h2>{countNoun(executions.length, "external action")}</h2></div><span className="quiet">Pinned version · exact arguments · attributable result</span></div>
      <div className="external-execution-list">
        {[...executions].reverse().map((execution) => {
          const request = cases.find((item) => item.id === execution.requestId);
          const resource = policy.resources.find((item) => item.id === execution.resourceId);
          const targetUrl = githubTargetUrl(execution);
          const resultUrl = execution.receipt?.resultUrl ?? targetUrl;
          const stale = ["pending_approval", "approved"].includes(execution.status) && !execution.attempt && !executionPolicyIsCurrent(workspace, execution);
          const builtIn = executionRequiresBuiltIn(workspace, execution);
          const accounting = externalExecutionAccounting(workspace, execution);
          return <article className="external-execution-card" key={execution.id}>
            <div className="external-execution-head">
              <div><span className={`execution-status ${execution.status}`}>{execution.status === "approved" && execution.attempt ? "Awaiting confirmation" : execution.status === "approved" && execution.authorizationMode === "policy_automatic" ? "Policy-authorized" : labels[execution.status]}</span><strong>{EXTERNAL_ACTIONS[execution.actionId].label}</strong><p>{execution.id} · GitHub connector · {execution.tool}</p></div>
              <div className="external-execution-links">
                {execution.status === "pending_approval" && <button className="button primary" type="button" onClick={() => onReview(execution)}>Review action</button>}
                {execution.status === "approved" && operatorReady && execution.actionId === "github.pull_request.merge" && execution.sourceFingerprint && <button className="button primary" type="button" disabled={Boolean(executionBusy) || stale} onClick={() => onExecute(execution)}>{executionBusy === execution.id ? "Checking GitHub…" : execution.attempt ? "Reconcile with GitHub" : "Execute exact action"}</button>}
                {execution.status === "approved" && !execution.attempt && <button className="button secondary" type="button" disabled={Boolean(executionBusy)} onClick={() => onRevoke(execution)}>Revoke if not invoked</button>}
                {resultUrl && <a href={resultUrl} target="_blank" rel="noreferrer">Open GitHub ↗</a>}
              </div>
            </div>
            <div className="external-execution-facts"><span><small>Request</small><strong>{request?.name ?? execution.requestId}</strong></span><span><small>Resource authorization</small><strong>{displayAmount(execution.authorizedAmount, resource?.unit ?? "units")}</strong></span><span><small>Authorization path</small><strong>{execution.authorizationMode === "human_approval" ? "Human checkpoint" : "Active policy"}</strong></span><span><small>Policy version</small><strong>{execution.policyVersionId}</strong></span></div>
            {stale && <p className="form-error">Policy or portfolio changed. Reject the pending action, or revoke an uninvoked approval, then review the current requests again.</p>}
            <details><summary>Exact action arguments</summary><dl className="execution-arguments">{Object.entries(execution.arguments).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{externalArgumentText(value)}</dd></div>)}</dl></details>
            {execution.sourceFingerprint && <p className="execution-next-step"><strong>Pinned source intake:</strong> <code>{execution.sourceFingerprint}</code></p>}
            {execution.budgetBinding && <p className="execution-next-step"><strong>Verified workflow budget:</strong> {execution.budgetBinding.path} · {execution.budgetBinding.pointer} · {execution.budgetBinding.mode === "increase" ? "increment from base" : "full new value"}. This authorizes the configuration change, not measured provider usage.</p>}
            {execution.status === "approved" && !stale && <p className="execution-next-step"><strong>Next:</strong> {execution.attempt ? "Reconcile the result with GitHub. The reservation is retained and another merge will not be sent." : operatorReady && execution.actionId === "github.pull_request.merge" && execution.sourceFingerprint ? "run this exact action with the connected RuleRipple operator." : builtIn ? "Complete GitHub connection setup in Connections, then use the built-in executor. External agents cannot dispatch this saved batch action." : <>a connected agent can invoke <code>{execution.tool}</code> with these exact arguments, then record the external receipt.</>}</p>}
            {execution.status === "succeeded" && execution.receipt?.actualUsage === undefined && <p className="execution-next-step"><strong>Recorded authorization:</strong> {displayAmount(execution.authorizedAmount, resource?.unit ?? "units")} was committed when this action completed. The receipt contains no metered usage.</p>}
            {execution.status === "succeeded" && execution.receipt?.actualUsage !== undefined && <p className="execution-next-step"><strong>Usage at receipt:</strong> {displayAmount(execution.receipt.actualUsage, resource?.unit ?? "units")} was recorded against this authorization; the unused remainder was released.</p>}
            {execution.status === "succeeded" && <p className="execution-next-step"><strong>Current request accounting:</strong> {displayAmount(accounting.requestTotals.reserved, resource?.unit ?? "units")} reserved · {displayAmount(accounting.requestTotals.committed, resource?.unit ?? "units")} committed · {displayAmount(accounting.requestTotals.consumed, resource?.unit ?? "units")} consumed. Includes all actions and later reconciliations for this request.</p>}
            {execution.receipt && <div className={`execution-receipt ${execution.receipt.status}`}><strong>{execution.receipt.summary}</strong><span>{execution.receipt.externalReference} · recorded {timeAgo(execution.receipt.recordedAt)}{execution.receipt.actualUsage === undefined ? "" : ` · actual ${displayAmount(execution.receipt.actualUsage, resource?.unit ?? "units")}`}</span></div>}
            {execution.approvedBy && <small>{execution.authorizationMode === "policy_automatic" ? "Authorized automatically by the active policy" : `Approved by ${publicReviewerIdentity(execution.approvedBy)}`}{execution.approvedAt ? ` · ${timeAgo(execution.approvedAt)}` : ""}</small>}
            {execution.cancelledBy && <small>Approval revoked by {publicReviewerIdentity(execution.cancelledBy)}{execution.cancelledAt ? ` · ${timeAgo(execution.cancelledAt)}` : ""}</small>}
          </article>;
        })}
        {!executions.length && <div className="guided-empty"><strong>No external action has been proposed</strong><p>Receive a request in Request inbox and verify its connected evidence, or ask an external WebMCP agent to propose a supported action. RuleRipple will enforce eligibility, allocation, the configured approval checkpoint, and exact arguments.</p></div>}
      </div>
    </section>
  </div>;
}

function PendingExternalExecutionReview({ execution, policy, stale, request, error, operatorReady, executionBusy, onClose, onApprove, onApproveAndExecute, onReject }: { execution: ExternalExecution; policy: Policy; stale: boolean; request?: TestCase; error: string; operatorReady: boolean; executionBusy: boolean; onClose: () => void; onApprove: () => void; onApproveAndExecute: () => void; onReject: () => void }) {
  const resource = policy.resources.find((item) => item.id === execution.resourceId), targetUrl = githubTargetUrl(execution);
  const canExecute = operatorReady && execution.actionId === "github.pull_request.merge" && Boolean(execution.sourceFingerprint);
  return <Modal title="Review external action" onClose={onClose}><div className="proposal-review external-review">
    {(error || stale) && <p className="form-error" role="alert">{error || "The policy or portfolio changed after this proposal. Reject it, then review the current requests again. No execution is authorized."}</p>}
    <div><span className="eyebrow">{execution.id} · {stale ? "policy changed" : "waiting for human approval"}</span><h3>{EXTERNAL_ACTIONS[execution.actionId].label}</h3><p>The pinned policy matched this request at proposal time. Review the exact GitHub action <strong>{execution.tool}</strong> for <strong>{request?.name ?? execution.requestId}</strong>.</p></div>
    <div className="comparison-summary"><article><span>Resource authorization</span><strong>{displayAmount(execution.authorizedAmount, resource?.unit ?? "units")}</strong><small>Reserved only after approval</small></article><article><span>Policy version</span><strong>{execution.policyVersionId}</strong><small>Pinned decision inputs</small></article><article><span>Argument fingerprint</span><strong>{execution.argumentsFingerprint}</strong><small>Detects changed arguments</small></article>{execution.sourceFingerprint && <article><span>Source fingerprint</span><strong>{execution.sourceFingerprint.slice(0, 18)}…</strong><small>Detects changed intake</small></article>}</div>
    <dl className="execution-arguments review">{Object.entries(execution.arguments).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{externalArgumentText(value)}</dd></div>)}</dl>
    {execution.sourceFingerprint && <p className="execution-next-step"><strong>Pinned source intake:</strong> <code>{execution.sourceFingerprint}</code></p>}
    {execution.budgetBinding && <p className="form-note"><strong>Verified workflow budget:</strong> {execution.budgetBinding.path} · {execution.budgetBinding.pointer} · {execution.budgetBinding.mode === "increase" ? "increase from base" : "full new value"}. The whole {displayAmount(execution.budgetBinding.amount, resource?.unit ?? "units")} change must be funded. This is not measured provider usage.</p>}
    {targetUrl && <a className="external-target-link" href={targetUrl} target="_blank" rel="noreferrer">Inspect the exact GitHub target ↗</a>}
    <p className="form-note">Approval reserves the displayed amount and permits only these exact arguments. Built-in pull-request execution also rechecks the inspected head SHA, mergeability, and declared Policy intake. {canExecute ? "Approve and execute runs the pinned action immediately, then records the GitHub receipt and accounting evidence." : "Approval alone does not invoke GitHub; rejection sends nothing and moves no capacity."}</p>
    <div className="form-actions"><button className="button secondary" type="button" disabled={executionBusy} onClick={onReject}>Reject action</button>{canExecute && <button className="button secondary" type="button" disabled={executionBusy || stale} onClick={onApprove}>Approve only</button>}<button className="button primary" type="button" disabled={executionBusy || stale} onClick={canExecute ? onApproveAndExecute : onApprove}>{executionBusy ? "Executing…" : canExecute ? "Approve & execute exact action" : "Approve exact action"}</button></div>
  </div></Modal>;
}

function RequestTable({ cases, evaluationById, allocationById, policy, onSelect, selectedId }: { cases: TestCase[]; evaluationById: Map<string, ReturnType<typeof allocateWorkspaceResources>["evaluations"][number]>; allocationById: Map<string, AllocationDecision>; policy: Policy; onSelect: (id: string) => void; selectedId?: string; }) {
  const resource = primaryResource(policy);
  const rows = cases.map((item) => { const evaluation = evaluationById.get(item.id), allocation = allocationById.get(item.id), resourceAllocation = allocation?.resources[resource.id]; const allocationLabel = resourceAllocation?.status === "partial" ? `${displayAmount(resourceAllocation.allocated, resource.unit)} partial` : allocation?.funded ? `${displayAmount(resourceAllocation?.allocated ?? 0, resource.unit)} allocated` : "Not allocated"; return { item, evaluation, allocation, resourceAllocation, allocationLabel }; });
  return <div className="table-wrap"><table className="request-table-desktop"><thead><tr><th>Request</th><th>Demand</th><th>Score</th><th>Rank</th><th>Outcome</th><th>Allocation</th></tr></thead><tbody>{rows.map(({ item, evaluation, allocation, resourceAllocation, allocationLabel }) => <tr className={selectedId === item.id ? "selected" : ""} key={item.id} onClick={() => onSelect(item.id)}><td><button className="case-select-button" type="button" onClick={(event) => { event.stopPropagation(); onSelect(item.id); }}>{item.name}</button>{item.source && <a className="request-source-link" href={item.source.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>GitHub · {item.source.externalId} ↗</a>}</td><td><span className="demand-value">{displayAmount(resourceAllocation?.rawRequested ?? item.demands[resource.id] ?? 0, resource.unit)}</span>{resourceAllocation && resourceAllocation.rawRequested !== resourceAllocation.requested && <small className="effective-demand">{displayAmount(resourceAllocation.requested, resource.unit)} effective</small>}</td><td>{evaluation?.score ?? "—"}</td><td>{allocation?.rank ? `#${allocation.rank}` : "—"}</td><td>{evaluation && <span className={`outcome ${evaluation.outcome}`}>{policy.outcomes[evaluation.outcome]}</span>}</td><td><span className={`funding-badge ${allocation?.funded ? "funded" : "not-funded"}`}>{allocationLabel}</span></td></tr>)}</tbody></table><div className="request-card-list">{rows.map(({ item, evaluation, allocation, resourceAllocation, allocationLabel }) => <button className={`request-mobile-card ${selectedId === item.id ? "selected" : ""}`} type="button" key={item.id} onClick={() => onSelect(item.id)}><span className="request-mobile-head"><strong>{item.name}</strong>{evaluation && <span className={`outcome ${evaluation.outcome}`}>{policy.outcomes[evaluation.outcome]}</span>}</span>{item.source && <span className="request-source-mobile">GitHub · {item.source.externalId}</span>}<span className="request-mobile-facts"><span><small>Demand</small><strong>{displayAmount(resourceAllocation?.rawRequested ?? item.demands[resource.id] ?? 0, resource.unit)}</strong>{resourceAllocation && resourceAllocation.rawRequested !== resourceAllocation.requested && <small>{displayAmount(resourceAllocation.requested, resource.unit)} effective</small>}</span><span><small>Score · rank</small><strong>{evaluation?.score ?? "—"} · {allocation?.rank ? `#${allocation.rank}` : "—"}</strong></span></span><span className={`funding-badge ${allocation?.funded ? "funded" : "not-funded"}`}>{allocationLabel}</span></button>)}</div>{!cases.length && <p className="empty-state">No requests match this view.</p>}</div>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const titleId = useId(); const ref = useRef<HTMLElement>(null); const onCloseRef = useRef(onClose); useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? []).filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const controls = focusable(), first = controls[0], last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); ref.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = previousOverflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}><div className="modal-head"><div><span className="eyebrow">RuleRipple workspace</span><h2 id={titleId}>{title}</h2></div><button type="button" onClick={onClose} aria-label="Close dialog">×</button></div>{children}</section></div>;
}
const FormActions = ({ onCancel, label }: { onCancel: () => void; label: string }) => <div className="form-actions full"><button className="button secondary" type="button" onClick={onCancel}>Cancel</button><button className="button primary" type="submit">{label}</button></div>;
