import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Bot, ChevronLeft, Plus, Share2, UsersRound } from "lucide-react";
import { ApiError } from "../api";
import { AccessSheet } from "../access/AccessSheet";
import { hubDocumentTitle, NEW_AGENT, type Route } from "../router";
import { Select } from "../ui/Select";
import { useConfirm } from "../ui/useConfirm";
import { AGENT_BOUNDS, type AgentApiUsage, type AgentDetail, type AgentSummary, type AgentToolRef, type KnowledgeCatalogBase, type LinkState, type NookLink, type ToolCatalog } from "../../shared/agents";
import { agentApiUsage, agentsStatus, createAgent, deleteAgent, errorCode, getAgent, listAgents, messageOf, toolCatalog, updateAgent, type AgentsStatus } from "./chatApi";
import { LinkNookKeySheet } from "./LinkNookKeySheet";
import { TrifectaBadge } from "./ToolDisclosure";
import { hasRef, nookGroups, nookWriteMode, orphanRefs, pickCounts, POLICY_BADGES, policyOptions, refKey, refName, setRefPolicy, toggleRef } from "./toolPicker";
import "./chat.css";

type Navigate = (route: Route, options?: { replace?: boolean }) => void;

/**
 * Settings → Agents (agent chat plan §13.4, AC-A: Basics, Instructions, Model, Starters; no tools
 * yet): a list, and an editor page below it at /settings/agents/:id (a nested hub page with its
 * own back link). Save uses CAS; a stale save says "Changed elsewhere".
 */
export function AgentsSettings({ agentId, navigate, flash, onOpenChat }: { agentId: string | null; navigate: Navigate; flash: (message: string) => void; onOpenChat: (agentId: string) => void }) {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await agentsStatus();
      setStatus(next);
      if (!next.enabled || !next.canChat) { setAgents([]); return; }
      setAgents((await listAgents()).agents);
      setError(null);
    } catch (reason) {
      setError(messageOf(reason, "Could not load agents"));
    }
  }, []);
  // Reloaded whenever the list comes back on screen (after the editor created, saved, or binned one), and
  // once for a deep link to the editor (Wave 41): `canCreate` comes from the status, so /settings/agents/new
  // opened directly must load it too.
  useEffect(() => { void load(); }, [agentId, load]);
  useEffect(() => { if (!agentId) document.title = hubDocumentTitle("Agents"); }, [agentId]);

  if (agentId) return <AgentEditor agentId={agentId} navigate={navigate} flash={flash} canCreate={status?.canCreate ?? false} onOpenChat={onOpenChat} />;
  const toList = { app: "settings" as const, section: "agents" as const };
  // Wave 43 (AC-D): your own agents, then those shared with you (with the owner and your level).
  const own = agents?.filter((agent) => agent.yourLevel === "owner") ?? null;
  const shared = agents?.filter((agent) => agent.yourLevel !== "owner") ?? [];
  const row = (agent: AgentSummary) => <li key={agent.id}>
    <button type="button" className="agents-row" onClick={() => navigate({ ...toList, agentId: agent.id })}>
      <span className="agents-row-icon" aria-hidden="true">{agent.icon || "🤖"}</span>
      <span className="agents-row-text"><strong>{agent.name}</strong><small>{agent.yourLevel !== "owner" ? `${agent.ownerName} · ${agent.yourLevel === "manage" ? "Manager" : "Can chat"} · ` : ""}{agent.description || "No description"} · {agent.model ?? status?.defaultModel ?? "default model"} · {agent.maxSteps} steps</small></span>
    </button>
    <button type="button" className="secondary-button" onClick={() => onOpenChat(agent.id)}>Chat</button>
  </li>;
  return <section className="settings-content agents-settings" aria-labelledby="agents-heading">
    <div className="settings-section-heading"><span className="settings-icon"><Bot /></span><div><h3 id="agents-heading">Agents</h3><p>An agent is a prompt, a model, a step limit, and the tools it may call. Your prompts are not secret: anyone you later share an agent with can read what it says through the model.</p></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {status && !status.enabled && <p className="settings-warning">Chat is not configured on this server{status.reason ? " (see Settings → AI)" : ""}.</p>}
    {status?.enabled && !status.canChat && <p className="settings-warning">Chat is off for your role.</p>}
    {own && own.length > 0 && <ul className="agents-list" aria-label="Your agents">{own.map(row)}</ul>}
    {agents && agents.length === 0 && status?.enabled && status.canChat && <p className="chat-muted">No agents yet.</p>}
    {shared.length > 0 && <><h4 className="agents-shared-heading"><UsersRound aria-hidden="true" />Shared with you</h4><ul className="agents-list" aria-label="Agents shared with you">{shared.map(row)}</ul></>}
    {status?.enabled && status.canCreate && <button type="button" className="secondary-button agents-add" onClick={() => navigate({ ...toList, agentId: NEW_AGENT })}><Plus />New agent</button>}
  </section>;
}

export type EditorForm = { name: string; description: string; icon: string; systemPrompt: string; model: string; maxSteps: number; temperature: string; starters: string; directWrites: boolean; tools: AgentToolRef[] };

/** Whether the editor's fields differ from the agent as loaded (Wave 41 QA Q2): such a form is never refilled by a background load. */
export function editorDiffers(agent: AgentDetail, form: EditorForm) {
  return form.name !== agent.name || form.description !== agent.description || form.icon !== (agent.icon ?? "") || form.systemPrompt !== (agent.systemPrompt ?? "")
    || form.model !== (agent.model ?? "") || form.maxSteps !== agent.maxSteps || form.temperature !== (agent.temperature === null ? "" : String(agent.temperature))
    || form.starters !== agent.starters.join("\n") || form.directWrites !== agent.nookDirectWrites || JSON.stringify(form.tools) !== JSON.stringify(agent.tools);
}

function AgentEditor({ agentId, navigate, flash, canCreate, onOpenChat }: { agentId: string; navigate: Navigate; flash: (message: string) => void; canCreate: boolean; onOpenChat: (agentId: string) => void }) {
  const creating = agentId === NEW_AGENT;
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [model, setModel] = useState("");
  const [maxSteps, setMaxSteps] = useState<number>(AGENT_BOUNDS.maxSteps.default);
  const [temperature, setTemperature] = useState("");
  const [starters, setStarters] = useState("");
  const [tools, setTools] = useState<AgentToolRef[]>([]);
  const [directWrites, setDirectWrites] = useState(false);
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [linking, setLinking] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const confirm = useConfirm();
  const ids = { name: useId(), description: useId(), icon: useId(), prompt: useId(), model: useId(), steps: useId(), temperature: useId(), starters: useId(), direct: useId() };
  const toList = { app: "settings" as const, section: "agents" as const };

  const fill = useCallback((detail: AgentDetail) => {
    setAgent(detail);
    setName(detail.name);
    setDescription(detail.description);
    setIcon(detail.icon ?? "");
    setSystemPrompt(detail.systemPrompt ?? "");
    setModel(detail.model ?? "");
    setMaxSteps(detail.maxSteps);
    setTemperature(detail.temperature === null ? "" : String(detail.temperature));
    setStarters(detail.starters.join("\n"));
    setTools(detail.tools);
    setDirectWrites(detail.nookDirectWrites);
    setStale(false);
  }, []);
  const loadCatalog = useCallback(async () => {
    try {
      setCatalog((await toolCatalog(creating ? null : agentId)).catalog);
    } catch {
      setCatalog(null);
    }
  }, [agentId, creating]);
  // Wave 41 QA Q2: `flash` and `navigate` are new functions on every parent render (a toast clearing
  // re-renders it); kept in refs so `load` does not re-run then and wipe what is being typed.
  const flashRef = useRef(flash);
  flashRef.current = flash;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // The form differs from the agent as loaded: never refilled behind the person's back (only Reload does).
  const dirtyRef = useRef<string | null>(null);
  dirtyRef.current = agent !== null && editorDiffers(agent, { name, description, icon, systemPrompt, model, maxSteps, temperature, starters, directWrites, tools }) ? agent.id : null;
  const load = useCallback(async (force = false) => {
    void loadCatalog();
    if (creating) return;
    try {
      const detail = (await getAgent(agentId)).agent;
      if (!force && dirtyRef.current === detail.id) return;
      fill(detail);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) { flashRef.current("Agent not found"); navigateRef.current({ app: "settings", section: "agents" }, { replace: true }); return; }
      setError(messageOf(reason, "Could not load the agent"));
    }
  }, [agentId, creating, fill, loadCatalog]);
  useEffect(() => { void load(); }, [load]);
  const onLinkChanged = useCallback((link: NookLink) => {
    setAgent((current) => current ? { ...current, linked: link !== null && (link.state === "active" || link.state === "grace"), linkState: link === null ? "none" : link.state === "active" || link.state === "grace" ? "live" : link.state === "revoked" ? "revoked" : link.state === "expired" ? "expired" : "inactive" } : current);
    void loadCatalog();
  }, [loadCatalog]);
  useEffect(() => { document.title = hubDocumentTitle(creating ? "New agent" : agent?.name ?? "Agent"); }, [agent?.name, creating]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    const temp = temperature.trim() === "" ? null : Number(temperature);
    if (temp !== null && (!Number.isFinite(temp) || temp < 0 || temp > 2)) return setError("Temperature is between 0 and 2.");
    setBusy(true);
    setError(null);
    const input = { name: name.trim(), description: description.trim(), icon: icon.trim() || null, systemPrompt, model: model.trim() || null, maxSteps, temperature: temp, starters: starters.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, AGENT_BOUNDS.starters), tools, nookDirectWrites: directWrites };
    try {
      if (creating) {
        const { agent: created } = await createAgent(input);
        flash("Agent created");
        navigate({ ...toList, agentId: created.id }, { replace: true });
      } else if (agent) {
        fill((await updateAgent(agent.id, { ...input, expectedRevision: agent.revision })).agent);
        flash("Saved");
      }
    } catch (reason) {
      if (errorCode(reason) === "REVISION_MISMATCH") setStale(true);
      else setError(messageOf(reason, "Could not save the agent"));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!agent) return;
    if (!await confirm.ask({ title: `Move ${agent.name} to the Bin?`, message: "Its chats stay readable; sending in them needs the agent restored. Deleted forever after 30 days.", confirmLabel: "Move to Bin", danger: true })) return;
    try {
      await deleteAgent(agent.id);
      flash("Moved to the Bin");
      navigate(toList, { replace: true });
    } catch (reason) {
      flash(messageOf(reason, "Could not delete the agent"));
    }
  }

  if (creating && !canCreate) return <div className="settings-content settings-team-content"><button type="button" className="team-back team-back-visible" onClick={() => navigate(toList)}><ChevronLeft />Agents</button><p className="settings-warning">Your role cannot create agents.</p></div>;
  // Wave 43 (D356): someone who may only chat with a shared agent sees what it is, never its prompt or tools.
  if (agent && agent.yourLevel === "view") return <AgentInfo agent={agent} onBack={() => navigate(toList)} onOpenChat={onOpenChat} onLink={() => setLinking(true)} linking={linking} onCloseLink={() => setLinking(false)} onLinkChanged={onLinkChanged} onOpenKeys={() => { setLinking(false); navigate({ app: "settings", section: "mcp" }); }} />;
  const canShareAgent = agent !== null && !creating && (agent.yourLevel === "owner" || agent.yourLevel === "manage");
  return <div className="settings-content settings-team-content agents-editor">
    <button type="button" className="team-back team-back-visible" onClick={() => navigate(toList)}><ChevronLeft />Agents</button>
    <div className="settings-section-heading"><span className="settings-icon"><Bot /></span><div><h3>{creating ? "New agent" : agent?.name ?? "Agent"}</h3><p>{agent && agent.yourLevel === "manage" ? `${agent.ownerName} owns this agent; you manage it. You can edit and share it; only ${agent.ownerName} can move it to the Bin.` : "Basics, instructions, the model, and the tools it may call."}</p></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {stale && <p className="settings-warning">Changed elsewhere. <button type="button" className="chat-link" onClick={() => { void load(true); }}>Reload</button></p>}
    {(creating || agent) && <form className="file-dialog-form agents-form" onSubmit={save}>
      <h4>Basics</h4>
      <label htmlFor={ids.name}>Name</label>
      <input id={ids.name} value={name} maxLength={AGENT_BOUNDS.agentName} autoComplete="off" autoFocus={creating} onChange={(event) => setName(event.target.value)} />
      <label htmlFor={ids.description}>Description</label>
      <input id={ids.description} value={description} maxLength={AGENT_BOUNDS.description} autoComplete="off" placeholder="What it is for" onChange={(event) => setDescription(event.target.value)} />
      <label htmlFor={ids.icon}>Emoji</label>
      <input id={ids.icon} value={icon} maxLength={16} autoComplete="off" placeholder="🤖" className="agents-icon-input" onChange={(event) => setIcon(event.target.value)} />
      <h4>Instructions</h4>
      <label htmlFor={ids.prompt}>System prompt <small>{systemPrompt.length.toLocaleString()} / {AGENT_BOUNDS.systemPrompt.toLocaleString()}</small></label>
      <textarea id={ids.prompt} className="agents-prompt" value={systemPrompt} maxLength={AGENT_BOUNDS.systemPrompt} rows={10} spellCheck={false} onChange={(event) => setSystemPrompt(event.target.value)} />
      <p className="file-dialog-hint">A fixed preamble goes before it: tool results and documents are untrusted, and secrets are never revealed. Put no secrets in prompts.</p>
      <h4>Model</h4>
      <label htmlFor={ids.model}>Model override</label>
      <input id={ids.model} value={model} maxLength={AGENT_BOUNDS.model} autoComplete="off" spellCheck={false} placeholder="The provider's default model" onChange={(event) => setModel(event.target.value)} />
      <span className="ai-label" id={ids.steps}>Max steps</span>
      <Select<string> labelledBy={ids.steps} label="Max steps" value={String(maxSteps)} onChange={(value) => setMaxSteps(Number(value))} options={Array.from({ length: AGENT_BOUNDS.maxSteps.max }, (_, index) => ({ value: String(index + 1), label: `${index + 1}${index + 1 === AGENT_BOUNDS.maxSteps.default ? " (default)" : ""}` }))} />
      <p className="file-dialog-hint">Model calls per answer. Without tools an answer is one call; the limit matters once tools arrive.</p>
      <label htmlFor={ids.temperature}>Temperature</label>
      <input id={ids.temperature} value={temperature} inputMode="decimal" autoComplete="off" placeholder="Provider default" onChange={(event) => setTemperature(event.target.value)} />
      <h4>Tools{catalog && <small> · {pickCounts(tools, catalog).total} picked</small>}</h4>
      {agent?.trifecta && <TrifectaBadge />}
      {agent && agent.hiddenTools > 0 && <p className="file-dialog-hint" role="note">{agent.hiddenTools === 1 ? "1 tool" : `${agent.hiddenTools} tools`} from servers or knowledge bases you can't use {agent.hiddenTools === 1 ? "is" : "are"} also picked. {agent.ownerName} manages {agent.hiddenTools === 1 ? "it" : "them"}; saving keeps {agent.hiddenTools === 1 ? "it" : "them"}.</p>}
      <ToolPicker catalog={catalog} tools={tools} directWrites={directWrites} linked={agent?.linked ?? false} linkState={agent?.linkState ?? "none"} creating={creating} onChange={setTools} onLink={() => setLinking(true)} />
      <label className="ai-check" htmlFor={ids.direct}><input id={ids.direct} type="checkbox" checked={directWrites} onChange={(event) => setDirectWrites(event.target.checked)} />Allow direct Nook writes (otherwise every Nook change becomes an Inbox proposal)</label>
      <p className="file-dialog-hint">Direct writes also need the linked key's write grant, and they still ask first in chats.</p>
      <h4>Starters</h4>
      <label htmlFor={ids.starters}>One per line, at most {AGENT_BOUNDS.starters}</label>
      <textarea id={ids.starters} value={starters} rows={3} onChange={(event) => setStarters(event.target.value)} />
      <footer className="file-dialog-actions agents-actions">
        {agent && <button type="button" className="secondary-button" onClick={() => onOpenChat(agent.id)}>Chat with it</button>}
        {canShareAgent && <button type="button" className="secondary-button" onClick={() => setSharing(true)}><Share2 />Share…</button>}
        {agent && agent.yourLevel === "owner" && <button type="button" className="secondary-button" onClick={() => { void remove(); }}>Move to Bin</button>}
        <button type="submit" className="primary-button" disabled={busy || stale}>{busy ? "Saving…" : creating ? "Create agent" : "Save"}</button>
      </footer>
    </form>}
    {agent && !creating && <AgentApiRuns agentId={agent.id} />}
    {linking && agent && <LinkNookKeySheet agentId={agent.id} agentName={agent.name} onClose={() => setLinking(false)} onChanged={onLinkChanged} onOpenKeys={() => { setLinking(false); navigate({ app: "settings", section: "mcp" }); }} />}
    {sharing && agent && <AccessSheet kind="agent" id={agent.id} title={agent.name} guardHistory note={AGENT_SHARE_NOTE} onClose={() => setSharing(false)} onSaved={() => { setSharing(false); flash("Access updated"); }} />}
    {confirm.confirmElement}
  </div>;
}

/** What sharing an agent means (D356, D359, T311, T322), under the Access sheet. */
export const AGENT_SHARE_NOTE = "Can view: they chat with it and never see its prompt or tools (prompts are not secret: the model can repeat them). Manager: they also edit and share it. Its Nook tools always run through each person's own linked key, never yours.";

/**
 * A shared agent for someone who may only chat with it (Wave 43, D356): name, description, owner,
 * model, and starters; never the prompt or the tools. Their own Nook key is linked here (D359): the
 * agent's Nook tools run through it, never through the owner's.
 */
function AgentInfo({ agent, onBack, onOpenChat, onLink, linking, onCloseLink, onLinkChanged, onOpenKeys }: {
  agent: AgentDetail; onBack: () => void; onOpenChat: (agentId: string) => void; onLink: () => void; linking: boolean; onCloseLink: () => void; onLinkChanged: (link: NookLink) => void; onOpenKeys: () => void;
}) {
  return <div className="settings-content settings-team-content agents-editor agents-info">
    <button type="button" className="team-back team-back-visible" onClick={onBack}><ChevronLeft />Agents</button>
    <div className="settings-section-heading"><span className="settings-icon" aria-hidden="true">{agent.icon || <Bot />}</span><div><h3>{agent.name}</h3><p>Shared with you by {agent.ownerName}. You can chat with it; its prompt and tools stay with its owner.</p></div></div>
    {agent.trifecta && <TrifectaBadge />}
    <dl className="agents-info-list">
      <dt>Description</dt><dd>{agent.description || "No description"}</dd>
      <dt>Model</dt><dd>{agent.model ?? "The provider's default model"} · up to {agent.maxSteps} steps</dd>
      {agent.starters.length > 0 && <><dt>Starters</dt><dd><ul>{agent.starters.map((starter) => <li key={starter}>{starter}</li>)}</ul></dd></>}
      <dt>Nook tools</dt><dd>{agent.usesNook ? agent.linked ? "They run through your linked Nook key." : agent.linkState !== "none" ? `${LINK_DEAD_SENTENCE[agent.linkState]}: link another to give it Nook's tools.` : "This agent can use Nook's tools through a key of yours. Without one it answers without them." : "This agent uses none of Nook's tools."}</dd>
    </dl>
    <footer className="file-dialog-actions agents-actions">
      {agent.usesNook && <button type="button" className="secondary-button" onClick={onLink}>{agent.linked ? "Change linked key" : "Link Nook key"}</button>}
      <button type="button" className="primary-button" onClick={() => onOpenChat(agent.id)}>Chat with it</button>
    </footer>
    {linking && <LinkNookKeySheet agentId={agent.id} agentName={agent.name} onClose={onCloseLink} onChanged={onLinkChanged} onOpenKeys={onOpenKeys} />}
  </div>;
}

/**
 * The agent's API and MCP runs for the people who manage it (Wave 42 "AC-C", D366): runs, failures,
 * and tokens per day over 30 days. Counts only; the runs themselves are in their key owner's Audit log.
 */
export function AgentApiRuns({ agentId }: { agentId: string }) {
  const [usage, setUsage] = useState<AgentApiUsage | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    agentApiUsage(agentId).then((result) => { if (!cancelled) setUsage(result.usage); }, () => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [agentId]);
  if (failed) return null;
  return <section className="agent-api-usage" aria-labelledby={`${agentId}-api-runs`}>
    <h4 id={`${agentId}-api-runs`}>API and MCP runs <small>· last 30 days</small></h4>
    {!usage ? <p className="chat-muted" role="status">Loading…</p>
      : usage.totals.runs === 0 ? <p className="chat-muted">No runs through API keys yet. A key with “Run agents” on this agent can run it; each run lands in its owner's Audit log.</p>
      : <>
        <p className="chat-muted">{apiRunsSummary(usage)}</p>
        <div className="agent-api-usage-wrap"><table>
          <thead><tr><th scope="col">Day</th><th scope="col">Runs</th><th scope="col">Failed</th><th scope="col">Tokens</th></tr></thead>
          <tbody>{usage.days.slice(0, 14).map((day) => <tr key={day.day}><td>{day.day}</td><td>{day.runs}</td><td>{day.errors}</td><td>{(day.promptTokens + day.completionTokens).toLocaleString()}</td></tr>)}</tbody>
        </table></div>
      </>}
  </section>;
}

/** "12 runs, 1 failed, 34,567 tokens". */
export const apiRunsSummary = (usage: AgentApiUsage) =>
  `${usage.totals.runs} ${usage.totals.runs === 1 ? "run" : "runs"}, ${usage.totals.errors} failed, ${(usage.totals.promptTokens + usage.totals.completionTokens).toLocaleString()} tokens`;

type ToolPickerProps = { catalog: ToolCatalog | null; tools: AgentToolRef[]; directWrites: boolean; linked: boolean; linkState: LinkState; creating: boolean; onChange: (tools: AgentToolRef[]) => void; onLink: () => void };

/** The picker (plan §5.2): a section per server with a checkbox per tool and an optional stricter policy; Nook's tools by module once a key is linked. */
/** A link whose key is no longer live (Wave 41 QA Q4). */
const LINK_DEAD: Record<LinkState, string> = { none: "", live: "", revoked: "Key revoked", expired: "Key expired", inactive: "Key inactive" };
/** The hint's sentence per state (AC-B verification L1): "The linked key was revoked", never "is key revoked". */
export const LINK_DEAD_SENTENCE: Record<LinkState, string> = { none: "", live: "", revoked: "The linked key was revoked", expired: "The linked key has expired", inactive: "The linked key is inactive" };

function ToolPicker({ catalog, tools, directWrites, linked, linkState, creating, onChange, onLink }: ToolPickerProps) {
  const dead = !linked && linkState !== "none" && linkState !== "live";
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!catalog) return <p className="chat-muted">Loading the tool catalog…</p>;
  const counts = pickCounts(tools, catalog);
  const orphans = orphanRefs(tools, catalog);
  const isOpen = (key: string, fallback: boolean) => open[key] ?? fallback;
  return <div className="agents-tools">
    {catalog.servers.length === 0 && <p className="chat-muted">No tool servers are available to you. An admin adds them in Settings → AI.</p>}
    {catalog.servers.map((server) => {
      const picked = counts.perServer.get(server.id) ?? 0;
      const expanded = isOpen(server.id, picked > 0);
      return <section key={server.id} className="agents-tools-group" aria-label={server.name}>
        <div className="agents-tools-head">
          <button type="button" className="chat-link" aria-expanded={expanded} onClick={() => setOpen({ ...open, [server.id]: !expanded })}><strong>{server.name}{!server.enabled && <span className="ai-badge">Disabled</span>}</strong></button>
          <small>{picked} of {server.tools.length} picked{server.status !== "ok" ? ` · ${server.status === "unknown" ? "not synced" : server.status.replace("_", " ")}` : ""}</small>
        </div>
        {expanded && (server.tools.length === 0 ? <p className="chat-muted">This server has no synced tools yet.</p> : server.tools.map((tool) => {
          const ref: AgentToolRef = { source: "server", serverId: server.id, toolName: tool.name, policy: null };
          const current = tools.find((item): item is Extract<AgentToolRef, { source: "server" }> => item.source === "server" && item.serverId === server.id && item.toolName === tool.name);
          return <div key={tool.name} className="agents-tool">
            <label><input type="checkbox" checked={current !== undefined} disabled={tool.policy === "off"} onChange={() => onChange(toggleRef(tools, ref))} />
              <span className="agents-tool-text"><span><code>{tool.name}</code><span className="agents-tool-badges"><span className={`ai-badge${tool.readOnly ? " ai-badge-ok" : ""}`}>{tool.readOnly ? "Read-only" : "Not read-only"}</span>{tool.openWorld && <span className="ai-badge ai-badge-warn">Open world</span>}<span className="ai-badge">{POLICY_BADGES[tool.policy]}</span></span></span><small>{tool.description || "No description"}</small></span>
            </label>
            {current && tool.policy !== "off" && <Select<"admin" | "confirm" | "off"> label={`Policy for ${tool.name}`} value={current.policy ?? "admin"} onChange={(value) => onChange(setRefPolicy(tools, server.id, tool.name, value === "admin" ? null : value))} options={policyOptions(tool.policy)} variant="compact" />}
          </div>;
        }))}
      </section>;
    })}
    {catalog.knowledge && <KnowledgeToolGroup bases={catalog.knowledge} tools={tools} onChange={onChange} />}
    <section className="agents-tools-group" aria-label="Nook">
      <div className="agents-tools-head">
        <strong>Nook{linked && <span className="ai-badge ai-badge-ok">Key linked</span>}{dead && <span className="ai-badge ai-badge-warn">{LINK_DEAD[linkState]} — link another</span>}</strong>
        <small>{counts.nook} picked</small>
      </div>
      <div className="agents-link-row">
        {creating ? <p className="chat-muted">Create the agent first, then link one of your Nook keys to give it Nook's tools.</p>
          : <><button type="button" className="secondary-button" onClick={onLink}>{linked ? "Change linked key" : dead ? "Link another key" : "Link Nook key"}</button>
            <p className="chat-muted">{linked ? "Nook's tools run through your linked key; the list shows what that key reaches." : dead ? `${LINK_DEAD_SENTENCE[linkState]}: this agent gets none of Nook's tools until you link another key.` : "Without a key this agent gets none of Nook's tools. Link a key to see and pick the tools it reaches."}</p></>}
      </div>
      {linked && nookGroups(catalog.nook.tools).map((group) => <div key={group.module}>
        <p className="agents-nook-module">{group.label}</p>
        {group.tools.map((tool) => {
          const ref: AgentToolRef = { source: "nook", toolName: tool.name };
          const mode = nookWriteMode(tool, directWrites);
          return <div key={tool.name} className="agents-tool">
            <label><input type="checkbox" checked={hasRef(tools, ref)} onChange={() => onChange(toggleRef(tools, ref))} />
              <span className="agents-tool-text"><span><code>{tool.name}</code><span className="agents-tool-badges">{mode === "read" ? <span className="ai-badge ai-badge-ok">Read-only</span> : mode === "proposal" ? <span className="ai-badge">Proposal · asks first</span> : mode === "direct" ? <span className="ai-badge ai-badge-warn">Direct write · asks first</span> : <span className="ai-badge">Needs direct writes</span>}</span></span><small>{tool.title} · {mode === "proposal" && tool.proposalScope ? `needs inbox:write and ${tool.proposalScope}` : `needs a key with ${tool.scope}`}</small></span>
            </label>
          </div>;
        })}
      </div>)}
      {!linked && !creating && counts.nook > 0 && <p className="chat-muted">{counts.nook} Nook {counts.nook === 1 ? "tool is" : "tools are"} picked but inactive until a key is linked.</p>}
    </section>
    {orphans.length > 0 && <div className="agents-tools-group">
      <div className="agents-tools-head"><strong>No longer available</strong><small>{orphans.length}</small></div>
      {orphans.map((ref) => <div key={refKey(ref)} className="agents-tool"><label><input type="checkbox" checked onChange={() => onChange(toggleRef(tools, ref))} /><span className="agents-tool-text"><code>{refName(ref)}</code><small>{ref.source === "server" ? "Its server or tool is gone; untick to clear it." : ref.source === "knowledge" ? "It is in the Bin, or no longer shared with you; untick to clear it." : "Not offered any more; untick to clear it."}</small></span></label></div>)}
    </div>}
  </div>;
}

/**
 * The picker's Knowledge group (plan §5.2; Wave 44 AC-E): the bases the editor can open, one
 * checkbox each. Attached bases become one read-only `search_knowledge` tool that runs on its own.
 */
export function KnowledgeToolGroup({ bases, tools, onChange }: { bases: KnowledgeCatalogBase[]; tools: AgentToolRef[]; onChange: (tools: AgentToolRef[]) => void }) {
  const attached = tools.filter((ref) => ref.source === "knowledge").length;
  return <section className="agents-tools-group" aria-label="Knowledge">
    <div className="agents-tools-head">
      <strong>Knowledge</strong>
      <small>{attached} attached</small>
    </div>
    {bases.length === 0 ? <p className="chat-muted">No knowledge bases yet. Make one in Settings → Knowledge, then attach it here.</p>
      : <>
        <p className="chat-muted">Attached bases become one read-only tool, search_knowledge, that runs on its own. Anyone who can use this agent can read their text.</p>
        {bases.map((kb) => {
          const ref: AgentToolRef = { source: "knowledge", kbId: kb.id };
          return <div key={kb.id} className="agents-tool">
            <label><input type="checkbox" checked={hasRef(tools, ref)} onChange={() => onChange(toggleRef(tools, ref))} />
              <span className="agents-tool-text"><span><strong>{kb.name}</strong><span className="agents-tool-badges">{kb.status === "ready" ? <span className="ai-badge ai-badge-ok">Ready</span> : kb.status === "indexing" ? <span className="ai-badge">Indexing</span> : kb.status === "error" ? <span className="ai-badge ai-badge-warn">Errors</span> : <span className="ai-badge">Empty</span>}</span></span><small>{kb.yours ? "Yours" : `${kb.ownerName}'s`} · {kb.chunkCount.toLocaleString()} chunks{kb.description ? ` · ${kb.description}` : ""}</small></span>
            </label>
          </div>;
        })}
      </>}
  </section>;
}
