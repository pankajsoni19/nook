import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Bot, ChevronLeft, Plus } from "lucide-react";
import { ApiError } from "../api";
import { hubDocumentTitle, NEW_AGENT, type Route } from "../router";
import { Select } from "../ui/Select";
import { useConfirm } from "../ui/useConfirm";
import { AGENT_BOUNDS, type AgentDetail, type AgentSummary } from "../../shared/agents";
import { agentsStatus, createAgent, deleteAgent, errorCode, getAgent, listAgents, messageOf, updateAgent, type AgentsStatus } from "./chatApi";
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
    <div className="settings-section-heading"><span className="settings-icon"><Bot /></span><div><h3 id="agents-heading">Agents</h3><p>An agent is a prompt, a model, and a step limit. Your prompts are not secret: anyone you later share an agent with can read what it says through the model.</p></div></div>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const confirm = useConfirm();
  const ids = { name: useId(), description: useId(), icon: useId(), prompt: useId(), model: useId(), steps: useId(), temperature: useId(), starters: useId() };
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
    setStale(false);
  }, []);
  const load = useCallback(async () => {
    if (creating) return;
    try {
      fill((await getAgent(agentId)).agent);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) { flash("Agent not found"); navigate(toList, { replace: true }); return; }
      setError(messageOf(reason, "Could not load the agent"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, creating, fill, flash, navigate]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { document.title = hubDocumentTitle(creating ? "New agent" : agent?.name ?? "Agent"); }, [agent?.name, creating]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    const temp = temperature.trim() === "" ? null : Number(temperature);
    if (temp !== null && (!Number.isFinite(temp) || temp < 0 || temp > 2)) return setError("Temperature is between 0 and 2.");
    setBusy(true);
    setError(null);
    const input = { name: name.trim(), description: description.trim(), icon: icon.trim() || null, systemPrompt, model: model.trim() || null, maxSteps, temperature: temp, starters: starters.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, AGENT_BOUNDS.starters) };
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
    <div className="settings-section-heading"><span className="settings-icon"><Bot /></span><div><h3>{creating ? "New agent" : agent?.name ?? "Agent"}</h3><p>Basics, instructions, and the model. Tools arrive in a later release.</p></div></div>
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
      <h4>Starters</h4>
      <label htmlFor={ids.starters}>One per line, at most {AGENT_BOUNDS.starters}</label>
      <textarea id={ids.starters} value={starters} rows={3} onChange={(event) => setStarters(event.target.value)} />
      <footer className="file-dialog-actions agents-actions">
        {agent && <button type="button" className="secondary-button" onClick={() => onOpenChat(agent.id)}>Chat with it</button>}
        {agent && <button type="button" className="secondary-button" onClick={() => { void remove(); }}>Move to Bin</button>}
        <button type="submit" className="primary-button" disabled={busy || stale}>{busy ? "Saving…" : creating ? "Create agent" : "Save"}</button>
      </footer>
    </form>}
    {confirm.confirmElement}
  </div>;
}
