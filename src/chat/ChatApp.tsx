import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Bot, Check, ChevronLeft, ChevronRight, Copy, Ellipsis, House, KeyRound, MessagesSquare, Pencil, Pin, Plus, RotateCcw, Search, Send, Sparkles, Square, Trash2, X } from "lucide-react";
import { AccountActions, AppPageName } from "../AppShell";
import { appName } from "../appName";
import { readHistoryDepth } from "../appShellNavigation";
import { ApiError } from "../api";
import { PHONE_QUERY, useMediaQuery } from "../calendar/hooks";
import { ModalDialog } from "../files/Dialog";
import { popStateClosedDialog } from "../historyDialogs";
import { routeFromLocation, type Route } from "../router";
import { chatBackAction, chatGroup, chatRoute, type ChatRoute } from "../chatRoute";
import { Select } from "../ui/Select";
import { useConfirm } from "../ui/useConfirm";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { AGENT_BOUNDS, type AgentSummary, type ChatDetail, type ChatMessage, type ChatSummary, type DailyUsage, type PendingConfirmation, type RunStatus, type TokenUsage, type ToolCallView } from "../../shared/agents";
import { agentsStatus, cancelRun, confirmRun, createChat, deleteChat, errorCode, followRun, getChat, listAgents, listChats, messageOf, myUsage, regenerate, sendMessage, updateChat, type AgentsStatus, type SequencedRunEvent, type StartedRun } from "./chatApi";
import { leafForSibling, shownBranch, type Shown } from "./chatTree";
import { LinkNookKeySheet } from "./LinkNookKeySheet";
import { Markdown, type RenderContext } from "./markdown/render";
import { ConfirmationCard, ToolCallsDisclosure, TrifectaBadge } from "./ToolDisclosure";
import "./chat.css";

type ChatNavigate = (route: Route, options?: { replace?: boolean; removed?: boolean }) => void;
type ChatAppProps = {
  displayName: string;
  role: string;
  navigate: ChatNavigate;
  flash: (message: string) => void;
  onHome: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  /** Opens Settings → Agents (the editor), a hub route. */
  onOpenAgents: (agentId?: string | null) => void;
  onOpenPath: (path: string) => void;
};

const currentRoute = (): ChatRoute => {
  const route = routeFromLocation(window.location);
  return route.app === "chat" ? route : chatRoute();
};

type LiveRun = { runId: string; messageId: string; text: string; usage: TokenUsage | null; error: { code: string; message: string } | null; status: RunStatus | null; seq: number; toolCalls: ToolCallView[]; pending: PendingConfirmation | null };
const freshLive = (runId: string, messageId: string, pending: PendingConfirmation | null = null): LiveRun => ({ runId, messageId, text: "", usage: null, error: null, status: null, seq: 0, toolCalls: [], pending });

const tokens = (usage: TokenUsage | null | undefined) => usage ? `${(usage.promptTokens + usage.completionTokens).toLocaleString()} tokens${usage.estimated ? " (est.)" : ""}` : null;
const ERROR_TEXT: Record<string, string> = {
  PROVIDER_ERROR: "The model provider did not answer",
  MODEL_TIMEOUT: "The model provider stopped answering",
  BUDGET_EXCEEDED: "Today's token budget is used up",
  NO_PROVIDER: "No model provider is configured",
  EGRESS_REFUSED: "The provider's address is not allowed",
  TOO_LARGE: "The reply was too large",
  INTERNAL: "Something went wrong while answering"
};

/**
 * Chat (Wave 40, agent chat plan §13): two columns on a computer (chats grouped by date | the chat),
 * one screen at a time on a phone (the list, then a chat as a pushed entry). Sheets and dialogs push
 * no history entry and close on Back (D18). A run keeps going when the tab leaves; the chat resumes
 * its stream from the ring when it comes back.
 */
export function ChatApp({ displayName, role, navigate, flash, onHome, onSettings, onSignOut, onOpenAgents, onOpenPath }: ChatAppProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  const [route, setRoute] = useState<ChatRoute>(currentRoute);
  const routeRef = useRef(route);
  routeRef.current = route;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const queryRef = useRef(query);
  queryRef.current = query;
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveRun | null>(null);
  const liveRef = useRef<LiveRun | null>(null);
  liveRef.current = live;
  const [usage, setUsage] = useState<DailyUsage | null>(null);
  const [draft, setDraft] = useState("");
  const [newAgentId, setNewAgentId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [externalLink, setExternalLink] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [linking, setLinking] = useState(false);
  const confirm = useConfirm();
  const paneRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const resetComposer = () => { if (composerRef.current) composerRef.current.style.height = ""; };
  const detailGeneration = useRef(0);
  const followController = useRef<AbortController | null>(null);

  const go = useCallback((next: ChatRoute, replace = false) => {
    setRoute(next);
    navigateRef.current(next, { replace });
  }, []);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (popStateClosedDialog(event)) return;
      const next = routeFromLocation(window.location);
      if (next.app === "chat") setRoute(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const next = await agentsStatus();
      setStatus(next);
      setStatusError(null);
      return next;
    } catch (reason) {
      setStatusError(messageOf(reason, "Could not load Chat"));
      return null;
    }
  }, []);
  const loadChats = useCallback(async (q = "") => {
    try {
      setChats((await listChats(q)).chats);
    } catch (reason) {
      if (!(reason instanceof ApiError && reason.status === 503)) flash(messageOf(reason, "Could not load chats"));
    }
  }, [flash]);
  const loadAgents = useCallback(async () => {
    try {
      setAgents((await listAgents()).agents);
    } catch {
      setAgents([]);
    }
  }, []);
  const loadUsage = useCallback(async () => {
    try { setUsage((await myUsage()).usage); } catch { /* the indicator is optional */ }
  }, []);

  useEffect(() => {
    void (async () => {
      const next = await loadStatus();
      if (!next?.enabled || !next.canChat) return;
      await Promise.all([loadChats(), loadAgents(), loadUsage()]);
    })();
  }, [loadAgents, loadChats, loadStatus, loadUsage]);
  useEffect(() => {
    if (!status?.enabled) return;
    const timer = window.setTimeout(() => { void loadChats(query); }, query ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [loadChats, query, status?.enabled]);

  // --- The open chat and its run ---
  const stopFollowing = useCallback(() => {
    followController.current?.abort();
    followController.current = null;
  }, []);

  const applyEvent = useCallback((event: SequencedRunEvent, replaying: boolean) => {
    setLive((current) => {
      if (!current || current.runId !== (event.type === "run" ? event.data.runId : current.runId)) return current;
      const next: LiveRun = { ...current, seq: Math.max(current.seq, event.seq) };
      if (event.type === "run") next.messageId = event.data.messageId;
      else if (event.type === "delta") next.text = ((replaying && current.seq === 0 ? "" : current.text) + event.data.text).slice(0, AGENT_BOUNDS.assistantMessageChars);
      else if (event.type === "usage") next.usage = event.data.usage;
      else if (event.type === "error") next.error = { code: event.data.code, message: event.data.message };
      else if (event.type === "done") next.status = event.data.status;
      else if (event.type === "tool_call") {
        if (!next.toolCalls.some((call) => call.id === event.data.callId)) next.toolCalls = [...next.toolCalls, { id: event.data.callId, tool: event.data.tool, server: event.data.server, serverId: event.data.serverId, argsPreview: event.data.argsPreview, resultPreview: null, ok: null, truncated: false, durationMs: null, decision: null, proposalId: null }];
      } else if (event.type === "tool_result") {
        next.toolCalls = next.toolCalls.map((call) => call.id === event.data.callId ? { ...call, ok: event.data.ok, resultPreview: event.data.resultPreview, truncated: event.data.truncated, durationMs: event.data.durationMs, decision: event.data.decision, proposalId: event.data.proposalId } : call);
      } else if (event.type === "confirmation_required") {
        const { messageId: _message, ...pending } = event.data;
        next.pending = pending;
      } else if (event.type === "confirmation_resolved") {
        if (next.pending?.confirmationId === event.data.confirmationId) next.pending = null;
        next.toolCalls = next.toolCalls.map((call) => call.id === event.data.callId ? { ...call, decision: event.data.decision } : call);
      } else if (event.type === "snapshot") {
        next.text = event.data.content;
        next.usage = event.data.usage;
        next.status = event.data.status;
        next.toolCalls = event.data.toolCalls;
        next.pending = event.data.pendingConfirmation;
        next.error = event.data.errorCode ? { code: event.data.errorCode, message: ERROR_TEXT[event.data.errorCode] ?? "The run did not finish" } : null;
      }
      return next;
    });
  }, []);

  const follow = useCallback((runId: string, after: number) => {
    stopFollowing();
    const controller = new AbortController();
    followController.current = controller;
    void (async () => {
      let since = after;
      for (let attempt = 0; !controller.signal.aborted; attempt += 1) {
        try {
          const outcome = await followRun(runId, since, (event) => {
            since = Math.max(since, event.seq);
            applyEvent(event, after === 0 && attempt === 0);
          }, controller.signal);
          if (outcome === "ended") {
            const chatId = routeRef.current.chatId;
            if (chatId) await refreshDetail(chatId, true);
            void loadUsage();
            void loadChats(queryRef.current);
          }
          return;
        } catch (reason) {
          if (controller.signal.aborted) return;
          if (reason instanceof ApiError && reason.status === 404) { setLive(null); return; }
          await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 500 * 2 ** Math.min(attempt, 4))));
        }
      }
    })();
    // The search text is read through a ref: typing in the search box must not restart the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyEvent, loadChats, loadUsage, stopFollowing]);

  const refreshDetail = useCallback(async (chatId: string, keepLive = false) => {
    const generation = ++detailGeneration.current;
    try {
      const next = await getChat(chatId);
      if (generation !== detailGeneration.current) return;
      setDetail(next);
      setDetailError(null);
      if (!keepLive) {
        if (next.activeRunId) {
          const message = next.messages.find((item) => item.runId === next.activeRunId && item.role === "assistant");
          setLive(freshLive(next.activeRunId, message?.id ?? "", next.pendingConfirmation));
          follow(next.activeRunId, 0);
        } else {
          setLive(null);
        }
      } else if (liveRef.current?.status) {
        setLive(null);
      }
    } catch (reason) {
      if (generation !== detailGeneration.current) return;
      if (reason instanceof ApiError && reason.status === 404) {
        flash("Chat not found");
        go(chatRoute(), true);
      } else {
        setDetailError(messageOf(reason, "Could not open this chat"));
      }
    }
  }, [flash, follow, go]);

  useEffect(() => {
    setMenuOpen(false);
    setEditing(null);
    stopFollowing();
    setLive(null);
    if (!route.chatId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    setDetail((current) => current?.chat.id === route.chatId ? current : null);
    void refreshDetail(route.chatId);
    return () => stopFollowing();
  }, [refreshDetail, route.chatId, stopFollowing]);

  // Leaving the tab closes the stream; coming back resumes it from the last seq (plan §2.3).
  useEffect(() => {
    const onVisibility = () => {
      const current = liveRef.current;
      if (!current || current.status) return;
      if (document.visibilityState === "hidden") stopFollowing();
      else if (!followController.current) follow(current.runId, current.seq);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [follow, stopFollowing]);

  useEffect(() => {
    // Wave 39: the app's own name follows APP_NAME.
    if (route.chatId && detail?.chat.id === route.chatId) document.title = `${detail.chat.title} · Chat · ${appName()}`;
    else document.title = route.newChat ? `New chat · Chat · ${appName()}` : `Chat · ${appName()}`;
  }, [detail, route.chatId, route.newChat]);

  useEffect(() => { setNewAgentId(route.newChat ? route.agentId ?? null : null); setDraft(""); resetComposer(); }, [route.newChat, route.agentId, route.chatId]);

  const back = useCallback(() => {
    const action = chatBackAction(routeRef.current, readHistoryDepth(window.history.state));
    if (action.kind === "history") window.history.back();
    else if (action.kind === "replace") go(action.route, true);
    else onHome();
  }, [go, onHome]);

  // Merge the live run into the messages on screen.
  const messages = useMemo<ChatMessage[]>(() => {
    if (!detail) return [];
    if (!live) return detail.messages;
    return detail.messages.map((message) => message.id === live.messageId ? { ...message, content: live.text || message.content, usage: live.usage ?? message.usage, status: live.status ? (live.status === "ok" ? "complete" : live.status === "cancelled" || live.status === "timeout" ? "cancelled" : live.status === "step_limit" ? "step_limit" : "error") : "streaming", errorCode: live.error?.code ?? message.errorCode, toolCalls: live.toolCalls.length ? live.toolCalls : message.toolCalls ?? [] } : message);
  }, [detail, live]);

  async function decide(decision: "once" | "deny", card: PendingConfirmation) {
    const current = liveRef.current;
    if (!current?.pending || deciding) return;
    setDeciding(true);
    try {
      // The card the person answered, not whatever card is newest now (review M1).
      await confirmRun(current.runId, card, decision);
    } catch (reason) {
      if (errorCode(reason) === "NO_PENDING_CONFIRMATION") setLive((value) => value ? { ...value, pending: null } : value);
      else flash(messageOf(reason, "Could not answer the confirmation"));
    } finally {
      setDeciding(false);
    }
  }
  const branch = useMemo(() => shownBranch(messages, detail?.chat.activeLeafId ?? null), [detail?.chat.activeLeafId, messages]);
  const running = Boolean(live && !live.status);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    // After layout, so the actions row that appears when a run ends is scrolled clear of the composer.
    const frame = requestAnimationFrame(() => pane.scrollTo({ top: pane.scrollHeight }));
    return () => cancelAnimationFrame(frame);
  }, [branch.length, live?.text.length, live?.status]);

  const startRun = useCallback((started: StartedRun, chatId: string) => {
    setDetail((current) => current && current.chat.id === chatId ? {
      ...current,
      chat: { ...current.chat, activeLeafId: started.assistantMessage.id, running: true },
      messages: [...current.messages, ...(started.userMessage ? [started.userMessage] : []), started.assistantMessage],
      activeRunId: started.runId
    } : current);
    setLive(freshLive(started.runId, started.assistantMessage.id));
    follow(started.runId, 0);
  }, [follow]);

  async function submit(content: string, parentId?: string | null) {
    const text = content.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      if (route.newChat) {
        if (!newAgentId) { flash("Choose an agent first"); return; }
        const { chat } = await createChat(newAgentId);
        const started = await sendMessage(chat.id, text);
        setDetail({ chat, messages: [started.userMessage!, started.assistantMessage], activeRunId: started.runId, pendingConfirmation: null });
        setDraft("");
        resetComposer();
        go(chatRoute(chat.id), true);
        setLive(freshLive(started.runId, started.assistantMessage.id));
        follow(started.runId, 0);
        void loadChats(query);
        return;
      }
      if (!route.chatId) return;
      const started = await sendMessage(route.chatId, text, parentId);
      if (parentId === undefined) { setDraft(""); resetComposer(); }
      setEditing(null);
      startRun(started, route.chatId);
    } catch (reason) {
      flash(failureText(reason, "Could not send"));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!live) return;
    try {
      await cancelRun(live.runId);
    } catch (reason) {
      flash(messageOf(reason, "Could not stop"));
    }
  }

  async function regenerateMessage(message: ChatMessage) {
    if (!route.chatId || running || busy) return;
    setBusy(true);
    try {
      const started = await regenerate(route.chatId, message.id);
      startRun(started, route.chatId);
    } catch (reason) {
      flash(failureText(reason, "Could not regenerate"));
    } finally {
      setBusy(false);
    }
  }

  async function switchBranch(shown: Shown, direction: 1 | -1) {
    if (!detail || running) return;
    const sibling = shown.siblings[shown.index + direction];
    if (!sibling) return;
    const leaf = leafForSibling(detail.messages, sibling);
    try {
      const { chat } = await updateChat(detail.chat.id, { activeLeafId: leaf, expectedRevision: detail.chat.revision });
      setDetail((current) => current ? { ...current, chat } : current);
    } catch (reason) {
      if (errorCode(reason) === "REVISION_MISMATCH") void refreshDetail(detail.chat.id);
      else flash(messageOf(reason, "Could not switch"));
    }
  }

  async function rename(title: string) {
    if (!detail) return;
    try {
      const { chat } = await updateChat(detail.chat.id, { title, expectedRevision: detail.chat.revision });
      setDetail((current) => current ? { ...current, chat } : current);
      setRenaming(false);
      void loadChats(query);
    } catch (reason) {
      flash(messageOf(reason, "Could not rename"));
    }
  }
  async function togglePin() {
    if (!detail) return;
    setMenuOpen(false);
    try {
      const { chat } = await updateChat(detail.chat.id, { pinned: !detail.chat.pinned, expectedRevision: detail.chat.revision });
      setDetail((current) => current ? { ...current, chat } : current);
      void loadChats(query);
    } catch (reason) {
      flash(messageOf(reason, "Could not pin"));
    }
  }
  async function remove() {
    if (!detail) return;
    setMenuOpen(false);
    if (!await confirm.ask({ title: "Move this chat to the Bin?", message: `“${detail.chat.title}” stays in the Bin for 30 days; a running answer stops.`, confirmLabel: "Move to Bin", danger: true })) return;
    try {
      await deleteChat(detail.chat.id);
      flash("Moved to the Bin");
      void loadChats(query);
      navigate(chatRoute(), { replace: true, removed: true });
      setRoute(chatRoute());
    } catch (reason) {
      flash(messageOf(reason, "Could not delete"));
    }
  }

  const renderContext = useMemo<RenderContext>(() => ({ onExternalLink: (href) => setExternalLink(href), onNookLink: (path) => onOpenPath(path) }), [onOpenPath]);
  const detailOpen = Boolean(route.chatId || route.newChat);
  const agentOptions = useMemo(() => (agents ?? []).map((agent) => ({ value: agent.id, label: `${agent.icon ? `${agent.icon} ` : ""}${agent.name}`, description: agent.description || (agent.model ?? status?.defaultModel ?? "") })), [agents, status?.defaultModel]);
  const newAgent = agents?.find((agent) => agent.id === newAgentId) ?? null;
  const chatAgent = detail ? agents?.find((agent) => agent.id === detail.chat.agentId) ?? null : null;
  const account = <AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} />;

  // --- Screens the module shows instead of chats ---
  const notice = statusError ? <section className="chat-state chat-error" role="alert"><p>{statusError}</p><button className="secondary-button" onClick={() => { void loadStatus(); }}>Retry</button></section>
    : status && !status.enabled ? <section className="chat-state"><span className="chat-state-icon"><Bot /></span><h2>Chat is not configured</h2>
      {role === "admin" ? <p>{status.reason === "key_mismatch" ? "AGENT_SECRETS_KEY does not open the stored provider secrets. Restore the key the providers were saved with, or remove and re-enter their API keys." : "Set AGENT_SECRETS_KEY (openssl rand -base64 32, different from the TOTP and vault keys) on the server, restart, then add a model provider in Settings → AI."} See docs/OPERATIONS.md, Agent chat.</p> : <p>Ask an admin to configure it.</p>}
    </section>
    : status && !status.canChat ? <section className="chat-state"><span className="chat-state-icon"><Bot /></span><h2>Chat is off for your role</h2><p>An admin decides which roles may chat with agents (Settings → AI).</p></section>
    : null;

  const groups = useMemo(() => {
    const map = new Map<string, ChatSummary[]>();
    for (const chat of chats ?? []) {
      const group = chatGroup(chat.updatedAt, chat.pinned);
      map.set(group, [...(map.get(group) ?? []), chat]);
    }
    return [...map.entries()];
  }, [chats]);

  const list = <section className="chat-list-pane split-pane" aria-label="Chats">
    <div className="chat-list-top">
      <button className="primary-button chat-new" onClick={() => go(chatRoute(null, { newChat: true }))} disabled={!agents || agents.length === 0}><Plus />New chat</button>
      <label className="chat-search"><Search aria-hidden="true" /><input type="search" value={query} placeholder="Search chats" aria-label="Search chats" onChange={(event) => setQuery(event.target.value)} /></label>
    </div>
    {agents && agents.length === 0 && <div className="chat-empty-agents"><p>No agents yet.</p>{status?.canCreate ? <button className="secondary-button" onClick={() => onOpenAgents("new")}>Create an agent</button> : <p className="chat-muted">Ask someone who can create agents.</p>}</div>}
    {chats === null ? <p className="chat-muted">Loading…</p> : chats.length === 0 && agents && agents.length > 0 ? <p className="chat-muted">{query ? "No chats match." : "No chats yet. Start one."}</p> : groups.map(([group, items]) => <div key={group} className="chat-group">
      <h3>{group}</h3>
      <ul>{items.map((chat) => <li key={chat.id}><button type="button" className={`chat-row${route.chatId === chat.id ? " active" : ""}`} aria-current={route.chatId === chat.id ? "page" : undefined} onClick={() => go(chatRoute(chat.id))}>
        <span className="chat-row-title">{chat.title}</span>
        <span className="chat-row-meta">{chat.agentIcon ? `${chat.agentIcon} ` : ""}{chat.agentName ?? "(agent deleted)"}{chat.running && <span className="chat-running-dot" aria-label="Answering" />}</span>
      </button></li>)}</ul>
    </div>)}
    <div className="chat-list-foot">
      <button type="button" className="chat-link" onClick={() => onOpenAgents(null)}>Agents</button>
      {role === "admin" && <button type="button" className="chat-link" onClick={onSettings}>Settings</button>}
    </div>
  </section>;

  const budget = usage && usage.budget > 0 ? Math.min(100, Math.round(((usage.promptTokens + usage.completionTokens) / usage.budget) * 100)) : null;

  const composer = <form className="chat-composer" onSubmit={(event: FormEvent) => { event.preventDefault(); void submit(draft); }}>
    <textarea
      ref={composerRef}
      value={draft}
      rows={1}
      placeholder={route.newChat ? (newAgent ? `Message ${newAgent.name}…` : "Choose an agent to start") : `Message ${chatAgent?.name ?? detail?.chat.agentName ?? "the agent"}…`}
      aria-label="Message"
      disabled={busy || (route.newChat && !newAgentId)}
      onChange={(event) => { setDraft(event.target.value); autoGrow(event.target); }}
      onKeyDown={(event) => {
        // Enter sends on a keyboard; Shift+Enter adds a line; on touch devices Enter only adds a line (plan §13.2).
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || window.matchMedia?.("(pointer: coarse)").matches) return;
        event.preventDefault();
        void submit(draft);
      }}
    />
    {running ? <button type="button" className="chat-stop" onClick={() => { void stop(); }}><Square />Stop</button>
      : <button type="submit" className="chat-send" disabled={busy || !draft.trim() || (route.newChat && !newAgentId)} aria-label="Send"><Send /></button>}
    <div className="chat-composer-foot">
      {budget !== null && usage && <span className={`chat-budget${budget >= 100 ? " chat-budget-full" : budget >= 80 ? " chat-budget-high" : ""}`} title={`${(usage.promptTokens + usage.completionTokens).toLocaleString()} of ${usage.budget.toLocaleString()} tokens today`}>{budget}% of today's tokens</span>}
      <span className="chat-muted">Messages leave this Nook for the configured model provider.</span>
    </div>
  </form>;

  const pane = <section ref={paneRef} className="chat-pane split-pane" aria-label="Chat">
    {!detailOpen ? <div className="chat-placeholder"><MessagesSquare /><p>Pick a chat, or start a new one.</p></div>
      : route.newChat ? <div className="chat-thread">
        <header className="chat-thread-header">
          {phone && <button type="button" className="icon-button chat-back" onClick={back} aria-label="Back to chats"><ChevronLeft /></button>}
          <div className="chat-agent-pick">
            <Select<string> label="Agent" value={newAgentId} onChange={(value) => setNewAgentId(value)} options={agentOptions} placeholder="Choose an agent" variant="chip" />
            {newAgent && <span className="chat-model-chip">{newAgent.model ?? status?.defaultModel ?? ""}</span>}
            {newAgent?.trifecta && <TrifectaBadge compact />}
          </div>
        </header>
        <div className="chat-empty">
          <span className="chat-state-icon"><Bot /></span>
          <h2>{newAgent ? newAgent.name : "New chat"}</h2>
          {newAgent?.description && <p>{newAgent.description}</p>}
          {newAgent && newAgent.starters.length > 0 && <div className="chat-starters">{newAgent.starters.map((starter) => <button key={starter} type="button" className="secondary-button" onClick={() => { void submit(starter); }}>{starter}</button>)}</div>}
        </div>
        {composer}
      </div>
      : detailError ? <div className="chat-state chat-error" role="alert"><p>{detailError}</p><button className="secondary-button" onClick={() => { if (route.chatId) void refreshDetail(route.chatId); }}>Retry</button></div>
      : !detail ? <p className="chat-muted chat-loading" role="status">Loading…</p>
      : <div className="chat-thread">
        <header className="chat-thread-header">
          {phone && <button type="button" className="icon-button chat-back" onClick={back} aria-label="Back to chats"><ChevronLeft /></button>}
          <button type="button" className="chat-agent-chip" onClick={() => { if (chatAgent?.isOwner) onOpenAgents(chatAgent.id); }} title={chatAgent ? chatAgent.description : detail.chat.agentId ? "This agent is in the Bin" : "This agent was deleted; start a new chat with another agent"}>{chatAgent?.icon ? `${chatAgent.icon} ` : ""}{detail.chat.agentName ?? "(agent deleted)"}</button>
          <span className="chat-model-chip">{chatAgent?.model ?? status?.defaultModel ?? ""}</span>
          {chatAgent?.trifecta && <TrifectaBadge compact />}
          <h2 className="chat-title">{detail.chat.title}</h2>
          <div className="chat-menu-anchor">
            <button type="button" className="icon-button" aria-label="More" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><Ellipsis /></button>
            {menuOpen && <ChatMenu onClose={() => setMenuOpen(false)} pinned={detail.chat.pinned} linked={chatAgent?.linked ?? false} canLink={chatAgent !== null} onRename={() => { setMenuOpen(false); setRenaming(true); }} onPin={() => { void togglePin(); }} onLink={() => { setMenuOpen(false); setLinking(true); }} onDelete={() => { void remove(); }} />}
          </div>
        </header>
        <ol className="chat-messages" aria-live="polite" aria-relevant="additions text">
          {branch.map((shown) => <MessageView key={shown.message.id} shown={shown} context={renderContext} streaming={live?.messageId === shown.message.id && running} live={live?.messageId === shown.message.id ? live : null} busy={busy || running} deciding={deciding} onDecide={(decision, card) => { void decide(decision, card); }}
            editing={editing?.id === shown.message.id ? editing.text : null}
            onEdit={(text) => setEditing({ id: shown.message.id, text })}
            onCancelEdit={() => setEditing(null)}
            onSubmitEdit={(text) => { void submit(text, shown.message.parentId); }}
            onRegenerate={() => { void regenerateMessage(shown.message); }}
            onSwitch={(direction) => { void switchBranch(shown, direction); }}
            onCopied={() => flash("Copied")} />)}
        </ol>
        {composer}
      </div>}
  </section>;

  return <main className={`app-page chat-app${detailOpen ? " chat-detail-open" : ""}`}>
    <header className="app-page-header">
      <button className="app-home-button" onClick={onHome}><House />Home</button>
      <span className="app-home-brand"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Chat</strong></span></span><AppPageName name="Chat" />
      {account}
    </header>
    {notice ?? <div className="chat-layout split-layout">{list}{pane}</div>}
    {renaming && detail && <RenameDialog title={detail.chat.title} onCancel={() => setRenaming(false)} onSave={(title) => { void rename(title); }} />}
    {externalLink && <ExternalLinkSheet href={externalLink} onClose={() => setExternalLink(null)} />}
    {linking && chatAgent && <LinkNookKeySheet agentId={chatAgent.id} agentName={chatAgent.name} onClose={() => setLinking(false)} onChanged={() => { void loadAgents(); }} />}
    {confirm.confirmElement}
  </main>;
}

function failureText(reason: unknown, fallback: string) {
  const code = errorCode(reason);
  if (code === "BUDGET_EXCEEDED") return ERROR_TEXT.BUDGET_EXCEEDED!;
  if (code === "NO_PROVIDER") return "No model provider is configured; an admin sets one in Settings → AI";
  if (code === "RUN_ACTIVE") return "This chat is still answering; stop it first";
  if (code === "AGENT_BUSY") return messageOf(reason, "Too many chats are answering right now");
  if (code === "AGENT_GONE") return "This chat's agent is in the Bin or was deleted; restore it, or start a new chat";
  return messageOf(reason, fallback);
}

function autoGrow(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
}

type MessageViewProps = {
  shown: Shown; context: RenderContext; streaming: boolean; live: LiveRun | null; busy: boolean; editing: string | null; deciding: boolean;
  onEdit: (text: string) => void; onCancelEdit: () => void; onSubmitEdit: (text: string) => void; onRegenerate: () => void; onSwitch: (direction: 1 | -1) => void; onCopied: () => void; onDecide: (decision: "once" | "deny", card: PendingConfirmation) => void;
};

function MessageView({ shown, context, streaming, live, busy, editing, deciding, onEdit, onCancelEdit, onSubmitEdit, onRegenerate, onSwitch, onCopied, onDecide }: MessageViewProps) {
  const { message, index, count } = shown;
  const user = message.role === "user";
  const switcher = count > 1 && <span className="chat-switcher" aria-label={`Version ${index + 1} of ${count}`}>
    <button type="button" className="icon-button" aria-label="Previous version" disabled={index === 0 || busy} onClick={() => onSwitch(-1)}><ChevronLeft /></button>
    <span>{index + 1} / {count}</span>
    <button type="button" className="icon-button" aria-label="Next version" disabled={index === count - 1 || busy} onClick={() => onSwitch(1)}><ChevronRight /></button>
  </span>;
  const copy = async () => {
    try { await navigator.clipboard.writeText(message.content); onCopied(); } catch { /* refused */ }
  };
  if (user) {
    return <li className="chat-message chat-user">
      {editing !== null ? <form className="chat-edit" onSubmit={(event) => { event.preventDefault(); onSubmitEdit(editing); }}>
        <textarea value={editing} rows={3} aria-label="Edit message" autoFocus onChange={(event) => onEdit(event.target.value)} />
        <div className="chat-edit-actions"><button type="button" className="secondary-button" onClick={onCancelEdit}>Cancel</button><button type="submit" className="primary-button" disabled={busy || !editing.trim()}>Save &amp; submit</button></div>
      </form> : <div className="chat-bubble"><p className="chat-user-text">{message.content}</p></div>}
      <div className="chat-message-actions">
        {switcher}
        {editing === null && <button type="button" className="chat-action" onClick={() => onEdit(message.content)} disabled={busy}><Pencil />Edit</button>}
      </div>
    </li>;
  }
  const failed = message.status === "error" || message.status === "interrupted";
  const footer = message.status === "cancelled" ? "Stopped" : message.status === "interrupted" ? "Stopped: server restarted" : message.status === "step_limit" ? "Stopped at the step limit" : message.status === "error" ? (live?.error?.message ?? ERROR_TEXT[message.errorCode ?? ""] ?? "The run did not finish") : null;
  return <li className={`chat-message chat-assistant${failed ? " chat-failed" : ""}`}>
    <ToolCallsDisclosure calls={message.toolCalls} running={streaming} />
    {live?.pending && streaming && <ConfirmationCard key={live.pending.confirmationId} confirmation={live.pending} busy={deciding} onDecide={onDecide} />}
    <div className="chat-bubble">
      {message.content ? <Markdown text={message.content} context={context} streaming={streaming} /> : streaming ? <span className="chat-thinking" aria-label={live?.pending ? "Waiting for your answer" : "Answering"}>…</span> : null}
      {footer && <p className={`chat-footer${failed ? " chat-footer-error" : ""}`} role={failed ? "alert" : undefined}>{footer}</p>}
    </div>
    {!streaming && <div className="chat-message-actions">
      {switcher}
      {message.content && <button type="button" className="chat-action" onClick={() => { void copy(); }}><Copy />Copy</button>}
      <button type="button" className="chat-action" onClick={onRegenerate} disabled={busy}><RotateCcw />{failed || message.status === "cancelled" ? "Retry" : "Regenerate"}</button>
      {tokens(message.usage) && <span className="chat-tokens">{tokens(message.usage)}</span>}
    </div>}
  </li>;
}

function ChatMenu({ onClose, pinned, linked, canLink, onRename, onPin, onLink, onDelete }: { onClose: () => void; pinned: boolean; linked: boolean; canLink: boolean; onRename: () => void; onPin: () => void; onLink: () => void; onDelete: () => void }) {
  useHistoryDialogGuard(true, onClose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    const onClick = (event: MouseEvent) => { if (!(event.target instanceof Element) || !event.target.closest(".chat-menu-anchor")) onClose(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onClick); };
  }, [onClose]);
  return <div className="chat-menu" role="menu">
    <button type="button" role="menuitem" onClick={onRename}><Pencil />Rename</button>
    <button type="button" role="menuitem" onClick={onPin}><Pin />{pinned ? "Unpin" : "Pin"}</button>
    {canLink && <button type="button" role="menuitem" onClick={onLink}><KeyRound />{linked ? "Linked Nook key…" : "Link Nook key…"}</button>}
    <button type="button" role="menuitem" className="danger" onClick={onDelete}><Trash2 />Move to Bin</button>
  </div>;
}

function RenameDialog({ title, onCancel, onSave }: { title: string; onCancel: () => void; onSave: (title: string) => void }) {
  const [value, setValue] = useState(title);
  useHistoryDialogGuard(true, onCancel);
  return <ModalDialog title="Rename chat" eyebrow="Chat" onClose={onCancel} className="chat-dialog">
    <form className="file-dialog-form" onSubmit={(event) => { event.preventDefault(); if (value.trim()) onSave(value.trim()); }}>
      <label htmlFor="chat-rename">Title</label>
      <input id="chat-rename" value={value} maxLength={120} autoFocus onChange={(event) => setValue(event.target.value)} />
      <footer className="file-dialog-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancel</button><button type="submit" className="primary-button" disabled={!value.trim()}>Save</button></footer>
    </form>
  </ModalDialog>;
}

/** The external-link sheet (plan §8, T304): the full URL is shown before it is followed. */
export function ExternalLinkSheet({ href, onClose }: { href: string; onClose: () => void }) {
  useHistoryDialogGuard(true, onClose);
  const [copied, setCopied] = useState(false);
  let host = href;
  try { host = new URL(href).host; } catch { /* shown as is */ }
  // A dialog, not the full-screen "sheet" variant: on phones it is a bottom sheet sized to its content (QA Q9).
  return <ModalDialog title="Open this link?" eyebrow={host} onClose={onClose} className="chat-dialog chat-link-sheet">
    <p className="chat-link-url"><code>{href}</code></p>
    <p className="file-dialog-hint">This link came from the agent's reply. Check the address, including anything after “?”, before opening it.</p>
    <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={() => { void navigator.clipboard.writeText(href).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }, () => undefined); }}>{copied ? <><Check />Copied</> : "Copy link"}</button>
      <button type="button" className="secondary-button" onClick={onClose}><X />Cancel</button>
      <a className="primary-button" href={href} target="_blank" rel="noopener noreferrer" onClick={onClose}>Open</a>
    </footer>
  </ModalDialog>;
}
