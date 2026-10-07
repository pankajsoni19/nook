import { Bot } from "lucide-react";
import { ApiError } from "../api";
import { errorCode } from "./chatApi";

/**
 * Losing the right to chat while an answer runs (TODO "ACCESS_REVOKED text"): the run ends
 * `ACCESS_REVOKED`, and every later Chat request answers 403 `ROLE_REFUSED`, so the chat (and its
 * stopped answer's footer) can no longer be loaded and the module shows "Chat is off for your role".
 * The explanation is kept and shown on that page, so the person learns why the answer stopped.
 */
export const ACCESS_REVOKED_TEXT = "You can no longer chat with this agent; the answer stopped";

/** Whether a request failed because the person may no longer chat (their role, or the agent, changed). */
export function accessLost(reason: unknown) {
  if (!(reason instanceof ApiError) || reason.status !== 403) return false;
  const code = errorCode(reason);
  return code === "ROLE_REFUSED" || code === "ACCESS_REVOKED";
}

/** The page Chat shows to a role that may not chat, with why an answer stopped when one did. */
export function ChatOffNotice({ revoked }: { revoked: string | null }) {
  return <section className="chat-state"><span className="chat-state-icon"><Bot /></span><h2>Chat is off for your role</h2>
    {revoked && <p className="chat-error" role="alert">{revoked}</p>}
    <p>An admin decides which roles may chat with agents (Settings → AI).</p>
  </section>;
}
