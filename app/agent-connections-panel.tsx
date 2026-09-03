"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { AgentConnection } from "../lib/agent-connections";
import type { WorkspaceData } from "../lib/domain";

async function connectionApi<T>(method = "GET", body?: unknown): Promise<T> {
  const response = await fetch("/api/agents", { method, cache: "no-store", headers: body ? { "content-type": "application/json" } : undefined, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json() as { detail?: string; error?: string };
  if (!response.ok) throw new Error(result.detail ?? (result.error === "AGENT_CONNECTION_STORE_UNAVAILABLE" ? "Connection storage is unavailable. The host must apply its agent-connection database rules." : "Could not manage connections. Sign in again or contact the workspace host."));
  return result as T;
}
export function AgentConnectionsPanel({ data, signedIn }: { data: WorkspaceData; signedIn: boolean }) {
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<{ connection: AgentConnection; credential: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoke, setRevoke] = useState<AgentConnection | null>(null);
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    void connectionApi<{ configured: boolean; connections: AgentConnection[] }>().then((result) => { if (active) { setConfigured(result.configured); setConnections(result.connections); } }).catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [signedIn]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true); setCopied(false); setIssued(null);
    const form = event.currentTarget, values = new FormData(form);
    try {
      const result = await connectionApi<{ connection: AgentConnection; credential: string }>("POST", { name: values.get("name"), system: values.get("system"), resourceId: values.get("resourceId"), maxRequested: Number(values.get("maxRequested")), days: Number(values.get("days")) });
      setConnections((prior) => [...prior, result.connection]); setIssued(result); form.reset();
    } catch (e) { setError(e instanceof Error ? e.message : "Connection could not be created."); }
    finally { setBusy(false); }
  }
  return <section className="agent-connections" aria-label="Agent connections">
    <h3>Connect a worker</h3><p>Give each agent its own identity and limited credential. It can submit requests and read its own decisions—not approve work, change policy, or execute an external action.</p>
    {!signedIn ? <p className="inbox-notice">Sign in and save your policy to connect an external worker.</p> : <>
      {configured === false && <p className="inbox-notice">The host must configure its server-side agent credential key before connections can be created. Existing requests are unchanged.</p>}
      {configured === null && !error && <p role="status">Checking agent connections…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {configured && <>
        <form onSubmit={create}><fieldset disabled={busy || Boolean(issued)}><div className="inbox-form-grid">
          <label>Agent name<input name="name" required maxLength={80} placeholder="Name of your worker" autoComplete="off" /></label>
          <label>Source system<input name="system" required maxLength={40} pattern="[a-z][a-z0-9_-]*" placeholder="e.g. github, slack, internal" autoComplete="off" /></label>
          <label>Resource<select name="resourceId" required>{data.policy.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.label} ({resource.unit})</option>)}</select></label>
          <label>Maximum requested per delivery item<input name="maxRequested" type="number" required min="0.000001" step="any" placeholder="Choose the worker’s limit" /></label>
          <label>Credential lifetime<select name="days" defaultValue="7"><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option></select></label>
        </div><button className="button primary" type="submit">{busy ? "Saving…" : "Create agent connection"}</button></fieldset></form>
        <p className="form-note">This limit controls each request, not a separate budget. All workers compete for the same policy capacity. Policy inputs are declared by the worker; external actions require evidence verification.</p>
        {issued && <div className="agent-credential" role="status"><h4>Credential created for {issued.connection.name}</h4><p>Copy the credential to your worker’s secret store now. It cannot be retrieved again. Never place it in source files or recordings.</p><label>One-time worker credential<input type="password" value={issued.credential} readOnly autoComplete="off" aria-label="One-time worker credential" /></label><div className="inbox-toolbar-actions"><button type="button" className="button primary" onClick={async () => { try { await navigator.clipboard.writeText(issued.credential); setCopied(true); } catch { setError("Clipboard access was denied. Select and copy the credential field using your browser."); } }}>{copied ? "Credential copied" : "Copy credential"}</button><button type="button" className="button secondary" onClick={() => { setIssued(null); setCopied(false); }}>I saved it securely</button></div><p>Endpoint: <code>{typeof window === "undefined" ? "" : window.location.origin}/api/agent-requests</code></p></div>}
        {connections.length > 0 && <ul className="agent-connection-list">{connections.map((connection) => <li key={connection.id}><div><strong>{connection.name}</strong><p>{connection.system} · {connection.resourceId} · up to {connection.maxRequested.toLocaleString()} per request</p><small>Expires {new Date(connection.expiresAt).toLocaleString()}</small></div><button className="button secondary" type="button" disabled={busy} onClick={() => setRevoke(connection)}>Revoke</button></li>)}</ul>}
        {revoke && <div className="inbox-notice" role="alert"><p>Revoke <strong>{revoke.name}</strong>? New deliveries and decision reads will stop. Existing requests, approvals, and receipts stay unchanged.</p><div className="inbox-toolbar-actions"><button type="button" className="button primary" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await connectionApi("DELETE", { id: revoke.id }); setConnections((prior) => prior.filter((c) => c.id !== revoke.id)); if (issued?.connection.id === revoke.id) setIssued(null); setRevoke(null); } catch (e) { setError(e instanceof Error ? e.message : "Revocation failed."); } finally { setBusy(false); } }}>Confirm revocation</button><button type="button" className="button secondary" disabled={busy} onClick={() => setRevoke(null)}>Keep connection</button></div></div>}
      </>}
    </>}
  </section>;
}
