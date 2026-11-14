import { useState } from "react";
import { PublicDone, PublicPageShell } from "./PublicPageShell";

/**
 * "Stop emails about this" from mail to an outside address (§B.7, T508, D822b). Opening the link
 * changes nothing (mail scanners open every link); the button POSTs the sealed token. The server
 * answers the same for any token, so the page says the same either way.
 */
export function MailStopPage({ path, appName }: { path: string; appName: string }) {
  const token = decodeURIComponent(path.slice("/p/mail-stop/".length).split("/")[0] ?? "");
  const [state, setState] = useState<"ask" | "busy" | "done" | "error">("ask");
  const stop = async () => {
    setState("busy");
    try {
      const response = await fetch(`/api/public/mail-stop/${encodeURIComponent(token)}`, { method: "POST", credentials: "omit", referrerPolicy: "no-referrer" });
      setState(response.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  };
  return <PublicPageShell workspaceName={appName} appName={appName} title={state === "done" ? undefined : "Stop emails about this?"}>
    {state === "done"
      ? <PublicDone title="Emails stopped">You will not get more emails about this.</PublicDone>
      : <>
        <p className="ui-public-text">You will get no more emails about this booking, poll, or form at this address. Emails about anything else are not affected.</p>
        {state === "error" && <p className="ui-public-text ui-public-error" role="alert">That did not work. Check your connection and try again.</p>}
        <div className="ui-public-actions">
          <button type="button" className="ui-public-button" disabled={state === "busy"} onClick={() => void stop()}>{state === "busy" ? "Stopping…" : "Stop emails"}</button>
        </div>
      </>}
  </PublicPageShell>;
}
