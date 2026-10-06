import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ShieldAlert, Wrench } from "lucide-react";
import { TRIFECTA_TEXT, type PendingConfirmation, type ToolCallView } from "../../shared/agents";
import "./chat.css";

/**
 * Tool disclosure and confirmation in a chat (agent chat plan §5.4, §13.2, D352; Wave 41 AC-B):
 * "Used N tools" collapses the calls of a reply (each with its server, name, argument and result
 * excerpts, duration, and how it went); the confirmation card asks Allow once / Deny for a tool
 * that must ask first, takes focus when it appears, and is inline (Back closes nothing here; the
 * run's pending state survives a reload because the ring replays it).
 */

export const TOOL_ERROR_TEXT: Record<string, string> = {
  DENIED: "Refused",
  TOOL_TIMEOUT: "The tool did not answer in time",
  TOOL_LIMIT: "Tool-call limit reached",
  UNKNOWN_TOOL: "Unknown tool",
  INVALID_ARGUMENTS: "The arguments were not valid JSON",
  EGRESS_REFUSED: "The tool server's address is not allowed",
  NETWORK: "The tool server could not be reached",
  MCP_AUTH: "The tool server refused the credential",
  MCP_HTTP: "The tool server answered with an error",
  MCP_PROTOCOL: "The tool server's answer was not valid",
  TOO_LARGE: "The tool sent more than allowed",
  KEY_INACTIVE: "The linked Nook key is no longer active",
  KIND_NOT_ALLOWED: "This change cannot be proposed through the Inbox"
};

/** The one-line outcome of a call: ok, a refusal, a known error code (from the result excerpt), or still running. */
export function callOutcome(call: ToolCallView): string {
  if (call.ok === null) return call.decision === null ? "Running…" : "Waiting…";
  if (call.decision === "denied") return "Denied";
  if (call.decision === "expired") return "Not answered in time";
  if (call.ok) return call.proposalId ? "Proposed in the Inbox" : "Done";
  try {
    const parsed = JSON.parse(call.resultPreview ?? "") as { code?: string };
    if (parsed.code && TOOL_ERROR_TEXT[parsed.code]) return TOOL_ERROR_TEXT[parsed.code]!;
  } catch { /* not an error object */ }
  return "Failed";
}

export const callLabel = (call: ToolCallView) => `Called ${call.server}/${call.tool}`;

export function ToolCallsDisclosure({ calls, running }: { calls: ToolCallView[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (calls.length === 0) return null;
  const summary = `${running && calls.some((call) => call.ok === null) ? "Using" : "Used"} ${calls.length} ${calls.length === 1 ? "tool" : "tools"}`;
  const total = calls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0);
  return <div className="chat-tools">
    <button type="button" className="chat-tools-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? <ChevronDown /> : <ChevronRight />}<Wrench />{summary}
      <span className="chat-tools-names">({[...new Set(calls.map((call) => call.tool))].join(", ")}){total > 0 ? ` ${(total / 1000).toFixed(1)} s` : ""}</span>
    </button>
    {open && <ol className="chat-tool-list">
      {calls.map((call) => <li key={call.id} className={`chat-tool-row${call.ok === false ? " chat-tool-failed" : ""}`}>
        <button type="button" className="chat-tool-head" aria-expanded={expanded === call.id} onClick={() => setExpanded(expanded === call.id ? null : call.id)}>
          <span className="chat-tool-name">{callLabel(call)}</span>
          <span className="chat-tool-outcome">{callOutcome(call)}{call.durationMs !== null ? ` · ${call.durationMs} ms` : ""}{call.truncated ? " · result cut" : ""}</span>
        </button>
        {expanded === call.id && <div className="chat-tool-detail">
          <span className="ai-label">Arguments</span>
          <pre>{call.argsPreview || "{}"}</pre>
          {call.resultPreview !== null && <><span className="ai-label">Result excerpt (untrusted)</span><pre>{call.resultPreview}</pre></>}
          {call.proposalId && <p className="chat-muted">Nothing was changed: the proposal waits in your Inbox.</p>}
        </div>}
      </li>)}
    </ol>}
  </div>;
}

export function ConfirmationCard({ confirmation, busy, onDecide }: { confirmation: PendingConfirmation; busy: boolean; onDecide: (decision: "once" | "deny") => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { ref.current?.focus(); }, [confirmation.callId]);
  const json = JSON.stringify(confirmation.args ?? {}, null, 2);
  const lines = json.split("\n");
  const long = lines.length > 20;
  return <div ref={ref} className="chat-confirm" role="group" aria-labelledby={`confirm-${confirmation.callId}`} tabIndex={-1}>
    <strong id={`confirm-${confirmation.callId}`}><ShieldAlert />{confirmation.proposal ? `The agent wants to propose ${confirmation.tool} in your Inbox` : `The agent wants to run ${confirmation.tool} on ${confirmation.server}`}</strong>
    <pre className="chat-confirm-args">{long && !showAll ? `${lines.slice(0, 20).join("\n")}\n…` : json}</pre>
    {long && <button type="button" className="chat-link" onClick={() => setShowAll(!showAll)}>{showAll ? "Show less" : `Show all ${lines.length} lines`}</button>}
    <p className="chat-muted">{confirmation.proposal ? "Allowing files a proposal; nothing changes until you approve it in the Inbox." : "The arguments were written by the model. Allow runs this call once; Deny tells the model it was refused."} Expires {new Date(confirmation.expiresAt).toLocaleTimeString()}.</p>
    <div className="chat-confirm-actions">
      <button type="button" className="secondary-button" onClick={() => onDecide("deny")} disabled={busy}>Deny</button>
      <button type="button" className="primary-button" onClick={() => onDecide("once")} disabled={busy}>Allow once</button>
    </div>
  </div>;
}

/** The lethal-trifecta badge (plan §5.2): on the agent editor and the chat header. */
export function TrifectaBadge({ compact = false }: { compact?: boolean }) {
  return <span className={`chat-trifecta${compact ? " chat-trifecta-compact" : ""}`} title={TRIFECTA_TEXT} role="note"><ShieldAlert />{compact ? "Reads your data · reaches outside" : TRIFECTA_TEXT}</span>;
}
