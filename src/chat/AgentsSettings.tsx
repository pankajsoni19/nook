import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Bot, ChevronLeft, Plus } from "lucide-react";
import { ApiError } from "../api";
import { hubDocumentTitle, NEW_AGENT, type Route } from "../router";
import { Select } from "../ui/Select";
import { useConfirm } from "../ui/useConfirm";
import { AGENT_BOUNDS, type AgentDetail, type AgentSummary, type AgentToolRef, type NookLink, type ToolCatalog } from "../../shared/agents";
import { agentsStatus, createAgent, deleteAgent, errorCode, getAgent, listAgents, messageOf, toolCatalog, updateAgent, type AgentsStatus } from "./chatApi";
import { LinkNookKeySheet } from "./LinkNookKeySheet";
import { TrifectaBadge } from "./ToolDisclosure";
import { hasRef, nookGroups, nookWriteMode, orphanRefs, pickCounts, POLICY_BADGES, policyOptions, refKey, setRefPolicy, toggleRef } from "./toolPicker";
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
  // Reloaded whenever the list comes back on screen (after the editor created, saved, or binned one).
  useEffect(() => { if (!agentId) void load(); }, [agentId, load]);
  useEffect(() => { if (!agentId) document.title = hubDocumentTitle("Agents"); }, [agentId]);

  if (agentId) return <AgentEditor agentId={agentId} navigate={navigate} flash={flash} canCreate={status?.canCreate ?? false} onOpenChat={onOpenChat} />;
  const toList = { app: "settings" as const, section: "agents" as const };
  return <section className="settings-content agents-settings" aria-labelledby="agents-heading">
    <div className="settings-section-heading"><span className="settings-icon"><Bot /></span><div><h3 id="agents-heading">Agents</h3><p>An agent is a prompt, a model, a step limit, and the tools it may call. Your prompts are not secret: anyone you later share an agent with can read what it says through the model.</p></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {status && !status.enabled && <p className="settings-warning">Chat is not configured on this server{status.reason ? " (see Settings → AI)" : ""}.</p>}
    {status?.enabled && !status.canChat && <p className="settings-warning">Chat is off for your role.</p>}
    {agents && agents.length > 0 && <ul className="agents-list">{agents.map((agent) => <li key={agent.id}>
      <button type="button" className="agents-row" onClick={() => navigate({ ...toList, agentId: agent.id })}>
        <span className="agents-row-icon" aria-hidden="true">{agent.icon || "🤖"}</span>
        <span className="agents-row-text"><strong>{agent.name}</strong><small>{agent.description || "No description"} · {agent.model ?? status?.defaultModel ?? "default model"} · {agent.maxSteps} steps</small></span>
      </button>
      <button type="button" className="secondary-button" onClick={() => onOpenChat(agent.id)}>Chat</button>
    </li>)}</ul>}
    {agents && agents.length === 0 && status?.enabled && status.canChat && <p className="chat-muted">No agents yet.</p>}
    {status?.enabled && status.canCreate && <button type="button" className="secondary-button agents-add" onClick={() => navigate({ ...toList, agentId: NEW_AGENT })}><Plus />New agent</button>}
  </section>;
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
    setSystemPrompt(detail.systemPrompt);
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
  const load = useCallback(async () => {
    void loadCatalog();
    if (creating) return;
    try {
      fill((await getAgent(agentId)).agent);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) { flash("Agent not found"); navigate(toList, { replace: true }); return; }
      setError(messageOf(reason, "Could not load the agent"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, creating, fill, flash, loadCatalog, navigate]);
  useEffect(() => { void load(); }, [load]);
  const onLinkChanged = useCallback((link: NookLink) => {
    setAgent((current) => current ? { ...current, linked: link !== null } : current);
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
  return <div className="settings-content settings-team-content agents-editor">
    <button type="button" className="team-back team-back-visible" onClick={() => navigate(toList)}><ChevronLeft />Agents</button>
    <div className="settings-section-heading"><span className="settings-icon"><Bot /></span><div><h3>{creating ? "New agent" : agent?.name ?? "Agent"}</h3><p>Basics, instructions, the model, and the tools it may call.</p></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {stale && <p className="settings-warning">Changed elsewhere. <button type="button" className="chat-link" onClick={() => { void load(); }}>Reload</button></p>}
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
      <ToolPicker catalog={catalog} tools={tools} directWrites={directWrites} linked={agent?.linked ?? false} creating={creating} onChange={setTools} onLink={() => setLinking(true)} />
      <label className="ai-check" htmlFor={ids.direct}><input id={ids.direct} type="checkbox" checked={directWrites} onChange={(event) => setDirectWrites(event.target.checked)} />Allow direct Nook writes (otherwise every Nook change becomes an Inbox proposal)</label>
      <p className="file-dialog-hint">Direct writes also need the linked key's write grant, and they still ask first in chats.</p>
      <h4>Starters</h4>
      <label htmlFor={ids.starters}>One per line, at most {AGENT_BOUNDS.starters}</label>
      <textarea id={ids.starters} value={starters} rows={3} onChange={(event) => setStarters(event.target.value)} />
      <footer className="file-dialog-actions agents-actions">
        {agent && <button type="button" className="secondary-button" onClick={() => onOpenChat(agent.id)}>Chat with it</button>}
        {agent && <button type="button" className="secondary-button" onClick={() => { void remove(); }}>Move to Bin</button>}
        <button type="submit" className="primary-button" disabled={busy || stale}>{busy ? "Saving…" : creating ? "Create agent" : "Save"}</button>
      </footer>
    </form>}
    {linking && agent && <LinkNookKeySheet agentId={agent.id} agentName={agent.name} onClose={() => setLinking(false)} onChanged={onLinkChanged} onOpenKeys={() => { setLinking(false); navigate({ app: "settings", section: "mcp" }); }} />}
    {confirm.confirmElement}
  </div>;
}

type ToolPickerProps = { catalog: ToolCatalog | null; tools: AgentToolRef[]; directWrites: boolean; linked: boolean; creating: boolean; onChange: (tools: AgentToolRef[]) => void; onLink: () => void };

/** The picker (plan §5.2): a section per server with a checkbox per tool and an optional stricter policy; Nook's tools by module once a key is linked. */
function ToolPicker({ catalog, tools, directWrites, linked, creating, onChange, onLink }: ToolPickerProps) {
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
    <section className="agents-tools-group" aria-label="Nook">
      <div className="agents-tools-head">
        <strong>Nook{linked && <span className="ai-badge ai-badge-ok">Key linked</span>}</strong>
        <small>{counts.nook} picked</small>
      </div>
      <div className="agents-link-row">
        {creating ? <p className="chat-muted">Create the agent first, then link one of your Nook keys to give it Nook's tools.</p>
          : <><button type="button" className="secondary-button" onClick={onLink}>{linked ? "Change linked key" : "Link Nook key"}</button>
            <p className="chat-muted">{linked ? "Nook's tools run through your linked key; the list shows what that key reaches." : "Without a key this agent gets none of Nook's tools, whatever is picked below."}</p></>}
      </div>
      {(linked || creating) && nookGroups(catalog.nook.tools).map((group) => <div key={group.module}>
        <p className="agents-nook-module">{group.label}</p>
        {group.tools.map((tool) => {
          const ref: AgentToolRef = { source: "nook", toolName: tool.name };
          const mode = nookWriteMode(tool, directWrites);
          return <div key={tool.name} className="agents-tool">
            <label><input type="checkbox" checked={hasRef(tools, ref)} onChange={() => onChange(toggleRef(tools, ref))} />
              <span className="agents-tool-text"><span><code>{tool.name}</code><span className="agents-tool-badges">{mode === "read" ? <span className="ai-badge ai-badge-ok">Read-only</span> : mode === "proposal" ? <span className="ai-badge">Proposal · asks first</span> : mode === "direct" ? <span className="ai-badge ai-badge-warn">Direct write · asks first</span> : <span className="ai-badge">Needs direct writes</span>}</span></span><small>{tool.title} · needs a key with {tool.scope}</small></span>
            </label>
          </div>;
        })}
      </div>)}
      {!linked && !creating && counts.nook > 0 && <p className="chat-muted">{counts.nook} Nook {counts.nook === 1 ? "tool is" : "tools are"} picked but inactive until a key is linked.</p>}
    </section>
    {orphans.length > 0 && <div className="agents-tools-group">
      <div className="agents-tools-head"><strong>No longer available</strong><small>{orphans.length}</small></div>
      {orphans.map((ref) => <div key={refKey(ref)} className="agents-tool"><label><input type="checkbox" checked onChange={() => onChange(toggleRef(tools, ref))} /><span className="agents-tool-text"><code>{ref.toolName}</code><small>{ref.source === "server" ? "Its server or tool is gone; untick to clear it." : "Not offered any more; untick to clear it."}</small></span></label></div>)}
    </div>}
  </div>;
}
