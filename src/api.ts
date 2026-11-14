let csrfToken = "";

export function setCsrfToken(token: string) {
  csrfToken = token;
}

export function getCsrfToken() {
  return csrfToken;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public payload?: unknown) {
    super(message);
  }
}

/**
 * Wave 23 QA F1: whether the last request failed at the network (or with a 5xx), and who wants to
 * know when a request succeeds again. Some browsers never fire `online` (phone emulation, some real
 * phones); the first successful response after a failure is the next best sign the network is back.
 */
let lastRequestFailed = false;
const recoveredListeners = new Set<() => void>();
export function onApiRecovered(listener: () => void) {
  recoveredListeners.add(listener);
  return () => { recoveredListeners.delete(listener); };
}
/** Records one request's outcome; after a failure, the first success tells the listeners. Exported for tests. */
export function noteRequestOutcome(ok: boolean) {
  if (!ok) { lastRequestFailed = true; return; }
  if (!lastRequestFailed) return;
  lastRequestFailed = false;
  for (const listener of [...recoveredListeners]) {
    try { listener(); } catch { /* a listener's failure is its own */ }
  }
}

/**
 * The request api() sends (D1180). The server refuses every mutation without a JSON Content-Type
 * (server/auth.ts requireMutationSafety), so a non-GET with no body is sent as `{}` with the
 * header; a bodyless DELETE or POST ("start a round", "move to Bin") would otherwise answer 415.
 * Exported for tests.
 */
export function apiRequestInit(options: RequestInit = {}): RequestInit {
  const method = (options.method ?? "GET").toUpperCase();
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  const headers = new Headers(options.headers);
  let body = options.body;
  if (mutation && (body === undefined || body === null || body === "")) body = "{}";
  if (body) headers.set("Content-Type", "application/json");
  if (csrfToken && mutation) headers.set("X-CSRF-Token", csrfToken);
  return { ...options, ...(body ? { body } : {}), headers, credentials: "same-origin" };
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, apiRequestInit(options));
  } catch (error) {
    noteRequestOutcome(false);
    throw error;
  }
  noteRequestOutcome(response.status < 500);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : `Request failed (${response.status})`;
    throw new ApiError(message, response.status, payload);
  }
  return payload as T;
}
