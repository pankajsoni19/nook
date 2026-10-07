import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../config";
import { isPrivateAddress } from "../calendar/push";
import { addressInRanges, parseEntry } from "../../shared/ipRanges";

/**
 * The one way out (plan §3.2, D347, T305–T307): every request the agent module makes to a
 * configurable host (the model endpoint now; MCP servers and embeddings in later slices) goes
 * through `egressFetch`.
 *
 * 1. The URL must be `https:` with no userinfo and no fragment; `http:` only for hosts listed in
 *    AGENT_ALLOWED_PRIVATE_HOSTS.
 * 2. The host is resolved (bounded) and every address is checked with `isPrivateAddress`: loopback,
 *    RFC 1918, CGNAT, link-local including 169.254.169.254, ULA, mapped forms, and 0.0.0.0 are
 *    refused unless the host name, or a CIDR covering every address, is on the allowlist. The check
 *    runs again on every request, so a DNS change is seen at the next call.
 *    The connection is pinned to the first checked address (T307, review L1): the request goes to
 *    `https://<address>:<port>/path` with `Host: <host>` and TLS `serverName: <host>` (Bun ignores
 *    `checkServerIdentity`, so the certificate is checked against the SNI name instead), so a DNS
 *    answer that changes between the check and the connect is never the one connected to.
 * 3. `redirect: "manual"`: any 3xx is `REDIRECT_REFUSED`.
 * 4. Nook's own origins (APP_ORIGINS) are refused, and so is any loopback or private address on
 *    Nook's own port (review L2): an alias of the listener that APP_ORIGINS does not spell.
 * 5. The body is read under a byte cap and three timeouts (first byte, idle between chunks, total).
 * 6. Outbound headers are exactly what the caller sets (the provider's Authorization, Content-Type,
 *    Accept) plus `User-Agent: Nook/<version>`: no cookie, session, or Nook key ever leaves (T306).
 * 7. Nothing here logs URLs with queries, headers, or bodies.
 */

export type EgressCode = "URL_REFUSED" | "PRIVATE_ADDRESS" | "REDIRECT_REFUSED" | "DNS_FAILED" | "TOO_LARGE" | "TIMEOUT" | "NETWORK";

export class EgressError extends Error {
  constructor(readonly code: EgressCode, message: string) {
    super(message);
    this.name = "EgressError";
  }
}

/** Network access on an object, so tests can replace DNS and fetch. */
export const agentNet = {
  resolve: async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address),
  fetch: (url: string, init: RequestInit) => fetch(url, init),
  resolveTimeoutMs: 5000
};

const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");

/** Whether `host` (or every address it resolves to) is on the private-host allowlist. */
export function privateHostAllowed(host: string, addresses: readonly string[], allowlist: readonly string[] = config.agents.allowedPrivateHosts) {
  if (allowlist.length === 0) return false;
  const names = allowlist.filter((entry) => !parseEntry(entry));
  if (names.includes(host)) return true;
  const ranges = allowlist.filter((entry) => parseEntry(entry));
  return ranges.length > 0 && addresses.length > 0 && addresses.every((address) => addressInRanges(ranges, address));
}

/**
 * The shape check alone (no DNS): a parsed URL, or `URL_REFUSED`. `allowHttp` is decided by the
 * caller after resolution (`http:` needs the allowlist), so the scheme is only pre-checked here.
 */
export function checkEgressUrl(value: string, options: { appOrigins?: ReadonlySet<string> } = {}): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EgressError("URL_REFUSED", "The endpoint URL is not valid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new EgressError("URL_REFUSED", "The endpoint must use https");
  if (url.username || url.password) throw new EgressError("URL_REFUSED", "The endpoint URL must not carry credentials");
  if (url.hash) throw new EgressError("URL_REFUSED", "The endpoint URL must not carry a fragment");
  if (!url.hostname) throw new EgressError("URL_REFUSED", "The endpoint URL needs a host");
  const origins = options.appOrigins ?? config.appOrigins;
  if (origins.has(url.origin)) throw new EgressError("URL_REFUSED", "The endpoint must not be this Nook");
  return url;
}

async function resolveBounded(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EgressError("DNS_FAILED", "The endpoint's host could not be resolved in time")), agentNet.resolveTimeoutMs); });
  try {
    return await Promise.race([agentNet.resolve(host), timeout]);
  } catch (error) {
    if (error instanceof EgressError) throw error;
    throw new EgressError("DNS_FAILED", "The endpoint's host could not be resolved");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The save-time rules for an endpoint an admin stores (a provider's base URL, a tool server's URL;
 * QA Q7, Wave 41 QA Q1): the shape check, plain http only for hosts in
 * AGENT_ALLOWED_PRIVATE_HOSTS, and a private literal address only when listed. No DNS here (the
 * request-time check resolves and re-checks every call).
 */
export function checkSavedEndpoint(value: string): URL {
  const url = checkEgressUrl(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  const literal = isIP(host) ? [host] : [];
  const listed = privateHostAllowed(host, literal);
  if (url.protocol === "http:" && !listed) throw new EgressError("URL_REFUSED", "Plain http is allowed only for hosts in AGENT_ALLOWED_PRIVATE_HOSTS");
  if (!listed && literal.some((address) => isPrivateAddress(address))) throw new EgressError("PRIVATE_ADDRESS", "The endpoint is a private or local address; list it in AGENT_ALLOWED_PRIVATE_HOSTS to allow it");
  return url;
}

/**
 * Shape plus DNS plus the private-range rule: the URL when it may be called now, else an
 * `EgressError`. Called before every request.
 */
export async function assertEgressAllowed(value: string, allowlist: readonly string[] = config.agents.allowedPrivateHosts): Promise<URL> {
  return (await resolveEgressTarget(value, allowlist)).url;
}

export type EgressTarget = { url: URL; host: string; addresses: string[] };

/** `assertEgressAllowed` plus the addresses the check saw, so the connection can be pinned to one of them. */
export async function resolveEgressTarget(value: string, allowlist: readonly string[] = config.agents.allowedPrivateHosts, ownPort: number = config.port): Promise<EgressTarget> {
  const url = checkEgressUrl(value);
  const host = hostOf(url);
  const addresses = await resolveBounded(host);
  if (addresses.length === 0) throw new EgressError("DNS_FAILED", "The endpoint's host has no address");
  const listed = privateHostAllowed(host, addresses, allowlist);
  if (url.protocol === "http:" && !listed) throw new EgressError("URL_REFUSED", "Plain http is allowed only for hosts in AGENT_ALLOWED_PRIVATE_HOSTS");
  const local = addresses.some((address) => isPrivateAddress(address));
  if (!listed && local) throw new EgressError("PRIVATE_ADDRESS", "The endpoint resolves to a private or local address; list it in AGENT_ALLOWED_PRIVATE_HOSTS to allow it");
  // Nook's own listener under another name (127.0.0.1, a container alias): the allowlist does not open it (review L2).
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (local && port === ownPort) throw new EgressError("URL_REFUSED", "The endpoint must not be this Nook");
  return { url, host, addresses };
}

/** The URL actually connected to: the checked address in place of the host (IPv6 in brackets), same port, path, and query. */
export function pinnedUrl(target: EgressTarget): string {
  const address = target.addresses[0]!;
  if (isIP(address) === 0 || address === hostOf(target.url)) return target.url.toString();
  const literal = address.includes(":") ? `[${address}]` : address;
  return `${target.url.protocol}//${literal}${target.url.port ? `:${target.url.port}` : ""}${target.url.pathname}${target.url.search}`;
}

export type EgressCaps = { maxBytes: number; firstByteMs: number; idleMs: number; totalMs: number };
export type EgressResponse = { status: number; headers: Headers; body: AsyncIterable<Uint8Array>; cancel: () => void };

/**
 * A guarded request. The returned body enforces the byte cap and the idle timeout chunk by chunk;
 * the first-byte and total timeouts abort the request. `init.headers` must carry only what the
 * provider needs.
 */
export async function egressFetch(value: string, init: { method: "GET" | "POST" | "DELETE"; headers?: Record<string, string>; body?: string; signal?: AbortSignal }, caps: EgressCaps, options: { allowlist?: readonly string[] } = {}): Promise<EgressResponse> {
  // `allowlist`: the private hosts this caller may reach; AGENT_ALLOWED_PRIVATE_HOSTS unless the caller
  // says otherwise (the chat image proxy passes its own, empty outside tests: review M1).
  const target = await resolveEgressTarget(value, options.allowlist ?? config.agents.allowedPrivateHosts);
  const { url } = target;
  const pinned = pinnedUrl(target);
  // Pinned (T307): the address the check saw, with the name in Host and in the TLS SNI, so the certificate
  // is still checked against the configured host. An IP-literal endpoint is already its own address.
  const pin: { headers?: Record<string, string>; tls?: { serverName: string } } = pinned === url.toString() ? {} : { headers: { Host: url.host }, ...(url.protocol === "https:" ? { tls: { serverName: target.host } } : {}) };
  const controller = new AbortController();
  const abort = (reason: EgressError) => controller.abort(reason);
  const onOuter = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) onOuter();
  init.signal?.addEventListener("abort", onOuter, { once: true });
  let firstByte: ReturnType<typeof setTimeout> | undefined = setTimeout(() => abort(new EgressError("TIMEOUT", "The endpoint did not answer in time")), caps.firstByteMs);
  const total = setTimeout(() => abort(new EgressError("TIMEOUT", "The endpoint took too long")), caps.totalMs);
  const cleanup = () => { clearTimeout(firstByte); clearTimeout(total); init.signal?.removeEventListener("abort", onOuter); };
  let response: Response;
  try {
    response = await agentNet.fetch(pinned, {
      method: init.method,
      headers: { ...(init.headers ?? {}), "User-Agent": `Nook/${config.appVersion}`, ...(pin.headers ?? {}) },
      body: init.body,
      redirect: "manual",
      signal: controller.signal,
      ...(pin.tls ? { tls: pin.tls } : {})
    } as RequestInit);
  } catch (error) {
    cleanup();
    if (controller.signal.aborted && controller.signal.reason instanceof EgressError) throw controller.signal.reason;
    if (init.signal?.aborted) throw init.signal.reason instanceof Error ? init.signal.reason : new EgressError("NETWORK", "The request was cancelled");
    throw new EgressError("NETWORK", "The endpoint could not be reached");
  }
  clearTimeout(firstByte);
  firstByte = undefined;
  if (response.status >= 300 && response.status < 400) {
    cleanup();
    try { await response.body?.cancel(); } catch { /* already gone */ }
    throw new EgressError("REDIRECT_REFUSED", "The endpoint answered with a redirect, which is not followed");
  }
  const reader = response.body?.getReader();
  let received = 0;
  const body: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      if (!reader) { cleanup(); return; }
      try {
        for (;;) {
          let idle: ReturnType<typeof setTimeout> | undefined;
          const stall = new Promise<never>((_, reject) => { idle = setTimeout(() => { const error = new EgressError("TIMEOUT", "The endpoint stopped sending"); abort(error); reject(error); }, caps.idleMs); });
          let result: { done: boolean; value?: Uint8Array };
          try {
            result = await Promise.race([reader.read(), stall]);
          } catch (error) {
            if (error instanceof EgressError) throw error;
            if (controller.signal.aborted && controller.signal.reason instanceof EgressError) throw controller.signal.reason;
            if (init.signal?.aborted) throw init.signal.reason instanceof Error ? init.signal.reason : new EgressError("NETWORK", "The request was cancelled");
            throw new EgressError("NETWORK", "The connection to the endpoint was lost");
          } finally {
            clearTimeout(idle);
          }
          if (result.done || !result.value) return;
          received += result.value.byteLength;
          if (received > caps.maxBytes) {
            abort(new EgressError("TOO_LARGE", "The endpoint sent more than allowed"));
            throw new EgressError("TOO_LARGE", "The endpoint sent more than allowed");
          }
          yield result.value;
        }
      } finally {
        cleanup();
        try { reader.releaseLock(); } catch { /* released */ }
      }
    }
  };
  return { status: response.status, headers: response.headers, body, cancel: () => { cleanup(); controller.abort(); } };
}

/** Reads a whole (small) body as text under the caps; for `/models` and error bodies. */
export async function readEgressText(response: EgressResponse, maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new EgressError("TOO_LARGE", "The endpoint sent more than allowed");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
