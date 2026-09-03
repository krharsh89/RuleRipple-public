"use client";
import { useCallback, useEffect, useState } from "react";
import type { BudgetNotification } from "../lib/github-notifications";

export function useGitHubNotifications(signedIn: boolean, revision: unknown) {
  const [records, setRecords] = useState<BudgetNotification[]>([]);
  const [configured, setConfigured] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [checkedAt, setCheckedAt] = useState(0);
  const refresh = useCallback(async () => {
    const response = await fetch("/api/github/notifications", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("GitHub receipt status could not be refreshed. Your budget decision is unchanged.");
    const value = await response.json() as { records?: BudgetNotification[]; configured?: boolean }; setRecords(value.records ?? []); setConfigured(value.configured === true); setError(""); setCheckedAt(Date.now());
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    const update = () => { if (active) void refresh().catch((e: Error) => { if (active) setError(e.message); }); };
    update(); const timer = setInterval(update, 15000);
    return () => { active = false; clearInterval(timer); };
  }, [signedIn, revision, refresh]);
  async function notify(requestId: string) {
    setBusyId(requestId); setActionError("");
    try {
      const response = await fetch("/api/github/notifications", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: requestId }) });
      const value = await response.json().catch(() => null) as { detail?: string } | null;
      if (!response.ok || !value) throw new Error(value?.detail ?? "Notification could not be sent. Check your GitHub connection; your budget remains saved.");
      await refresh();
    } catch (e) { setActionError(e instanceof Error ? e.message : "Notification failed. Budget unchanged."); }
    finally { setBusyId(""); }
  }
  return { records: signedIn ? records : [], configured: signedIn && configured, error: signedIn ? actionError || error : "", busyId, checkedAt, notify };
}
export function GitHubNotificationStatus({ requestId, settled, state }: { requestId: string; settled: boolean; state: ReturnType<typeof useGitHubNotifications> }) {
  const record = state.records.filter((r) => r.requestId === requestId).sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];
  const acknowledged = record?.state === "acknowledged";
  const pending = record && ["dispatching", "sent", "uncertain"].includes(record.state);
  const cooling = record && state.checkedAt - Date.parse(record.sentAt) < 60_000;
  return <section className="inbox-notification" aria-label="GitHub approval receipt">
    <strong>{acknowledged ? "GitHub worker acknowledged" : pending ? "Waiting for GitHub receipt" : "Inform the GitHub worker"}</strong>
    <p>{!state.checkedAt ? "Checking GitHub receipt status…" : acknowledged ? `${record.remaining.toLocaleString()} ${record.unit} remaining authorization was confirmed on ${new Date(record.receipt!.at).toLocaleString()}.` : !state.configured ? "The host has not enabled GitHub approval notifications." : record?.state === "failed" ? "Notification was not accepted. Check the GitHub connection and installed workflow, then retry." : pending ? "The workflow rechecks the saved authorization before sending its acknowledgement." : "Send the saved approval back to the workflow. This does not approve additional budget."}</p>
    {acknowledged && <a href={record.receipt!.url} target="_blank" rel="noreferrer">View GitHub receipt ↗</a>}
    {!acknowledged && !settled && <button type="button" className="button secondary" disabled={!state.configured || Boolean(state.busyId) || Boolean(cooling)} onClick={() => void state.notify(requestId)}>{state.busyId === requestId ? "Notifying GitHub…" : record ? "Retry notification" : "Notify GitHub"}</button>}
    <small>Receipt only · no workload execution or measured usage.</small>
  </section>;
}
