import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A session's live state (D1075): fetched once, then kept current by the server-sent event stream
 * (`event: state` carries the whole state for this viewer). When the stream cannot open or keeps
 * dropping (a proxy that buffers, an old browser), it falls back to polling every few seconds. A
 * `gone` event (access removed, binned, link revoked) ends it with `gone: true`.
 */
export function useLiveState<T>(options: { load: () => Promise<T>; streamUrl: string | null; pollMs?: number }) {
  const { load, streamUrl, pollMs = 5000 } = options;
  const [state, setState] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [gone, setGone] = useState(false);
  const [mode, setMode] = useState<"connecting" | "live" | "polling">("connecting");
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      const next = await loadRef.current();
      setState(next);
      setError(null);
    } catch (reason) {
      const status = (reason as { status?: number }).status;
      if (status === 404) setGone(true);
      setError(reason);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh, streamUrl]);

  useEffect(() => {
    if (!streamUrl || gone) return;
    let source: EventSource | null = null;
    let poll: number | null = null;
    let failures = 0;
    let closed = false;
    const startPolling = () => {
      if (poll !== null) return;
      setMode("polling");
      poll = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, pollMs);
    };
    const open = () => {
      if (closed || typeof EventSource === "undefined") { startPolling(); return; }
      source = new EventSource(streamUrl, { withCredentials: true });
      source.addEventListener("open", () => { failures = 0; setMode("live"); if (poll !== null) { window.clearInterval(poll); poll = null; } });
      source.addEventListener("state", (event) => {
        try { setState(JSON.parse((event as MessageEvent<string>).data) as T); setError(null); } catch { /* a torn frame: the next one fixes it */ }
      });
      source.addEventListener("gone", () => { closed = true; source?.close(); setGone(true); });
      source.addEventListener("error", () => {
        source?.close();
        failures += 1;
        if (closed) return;
        // Retry the stream a few times with a growing pause, polling meanwhile.
        startPolling();
        if (failures <= 6) window.setTimeout(open, Math.min(30_000, 1000 * 2 ** failures));
      });
    };
    open();
    return () => {
      closed = true;
      source?.close();
      if (poll !== null) window.clearInterval(poll);
    };
  }, [streamUrl, gone, pollMs, refresh]);

  return { state, setState, error, gone, mode, refresh };
}
