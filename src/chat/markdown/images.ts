/**
 * Images in agent Markdown (D370 as amended, T304): which `![alt](src)` may load, and how.
 *
 * - **Nook images** load at once: a same-origin path to one of Nook's own access-checked image
 *   routes (a file's content, a whiteboard thumbnail, a tool image of a chat). The viewer's own
 *   session decides whether it loads, so it reveals nothing the viewer could not already open, and
 *   the request never leaves Nook. Any other same-origin path is not an image source (a GET with
 *   side effects must not be reachable through `![](…)`).
 * - **`data:` images** load at once when they are PNG, JPEG, GIF, or WebP (never SVG), base64, at
 *   most `DATA_IMAGE_MAX_BYTES` decoded, and their first bytes match the declared type. They make no
 *   request at all. They count against the stored message bound like any other text.
 * - **External http(s) images** never load on their own: a card names the alt text and the full host,
 *   and **Load image** fetches the picture through Nook's image proxy (`/api/agents/image-proxy`),
 *   so the page CSP stays `img-src 'self' data:`, the viewer's address is not exposed, and the bytes
 *   are checked to be an image. The click is the consent; the URL, query and all, reaches that host.
 *   The proxy loads public https addresses on port 443 only; anything else, and any failure on the
 *   far side, is one message: "That image could not be loaded" (security review M1).
 *   "Always load from this host" lasts for this chat, in this tab, until it is reloaded.
 * - Everything else (SVG, other types, other schemes, oversized or malformed data) is refused and
 *   shows as a chip, as before.
 *
 * The public chat page never proxies and never loads Nook paths (the reader may have no session):
 * external and Nook images stay chips there; `data:` images, which make no request, still show.
 */

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
/** The largest `data:` image shown, decoded. The stored message bound (256 Ki characters) is the tighter cap in practice. */
export const DATA_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** The proxy's cap, mirrored from server/agents/images.ts. */
export const PROXY_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_PROXY_PATH = "/api/agents/image-proxy";
/** The header the proxy requires: an `<img>`, a link, or another site's page cannot send it. */
export const IMAGE_PROXY_HEADER = "X-Nook-Image-Proxy";

export type ImageRefusal = "svg" | "type" | "too-large" | "invalid" | "scheme" | "path";
export type ImageTarget =
  | { kind: "nook"; src: string }
  | { kind: "data"; src: string; mimeType: ImageMimeType; bytes: number }
  | { kind: "external"; url: URL }
  | { kind: "refused"; reason: ImageRefusal };

const pageOrigin = () => (typeof location !== "undefined" && location.origin && location.origin !== "null" ? location.origin : "https://nook.invalid");

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
/** Nook's own image routes, each access-checked on the server with the viewer's session. */
const NOOK_IMAGE_ROUTES: Array<[RegExp, (match: RegExpExecArray) => string]> = [
  [new RegExp(`^/api/files/(${UUID})/content$`), (match) => `/api/files/${match[1]!.toLowerCase()}/content?disposition=inline`],
  [new RegExp(`^/files/(${UUID})$`), (match) => `/api/files/${match[1]!.toLowerCase()}/content?disposition=inline`],
  [new RegExp(`^/api/whiteboards/(${UUID})/thumbnail$`), (match) => `/api/whiteboards/${match[1]!.toLowerCase()}/thumbnail`],
  [new RegExp(`^/api/chats/(${UUID})/tool-images/(${UUID})$`), (match) => `/api/chats/${match[1]!.toLowerCase()}/tool-images/${match[2]!.toLowerCase()}`]
];

const SIGNATURES: Record<ImageMimeType, (head: Uint8Array) => boolean> = {
  "image/png": (head) => head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a,
  "image/jpeg": (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
  "image/gif": (head) => String.fromCharCode(...head.slice(0, 6)) === "GIF87a" || String.fromCharCode(...head.slice(0, 6)) === "GIF89a",
  "image/webp": (head) => String.fromCharCode(...head.slice(0, 4)) === "RIFF" && String.fromCharCode(...head.slice(8, 12)) === "WEBP"
};

/** The image type the first bytes show, or null (SVG, HTML, and everything else). */
export function sniffImage(head: Uint8Array): ImageMimeType | null {
  for (const type of IMAGE_MIME_TYPES) if (SIGNATURES[type](head)) return type;
  return null;
}

function decodeHead(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64.slice(0, 16));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function classifyData(value: string): ImageTarget {
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)((?:;[a-z0-9-]+=[a-z0-9.+-]+)*)(;base64)?,(.*)$/is.exec(value);
  if (!match) return { kind: "refused", reason: "invalid" };
  const declared = match[1]!.toLowerCase();
  if (declared.startsWith("image/svg")) return { kind: "refused", reason: "svg" };
  const mimeType = (declared === "image/jpg" ? "image/jpeg" : declared) as ImageMimeType;
  if (!IMAGE_MIME_TYPES.includes(mimeType)) return { kind: "refused", reason: "type" };
  if (!match[3]) return { kind: "refused", reason: "invalid" };
  const payload = match[4]!.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 !== 0) return { kind: "refused", reason: "invalid" };
  const bytes = (payload.length / 4) * 3 - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
  if (bytes > DATA_IMAGE_MAX_BYTES) return { kind: "refused", reason: "too-large" };
  const head = decodeHead(payload);
  // The bytes must be the declared type: an SVG or HTML payload labelled image/png is refused.
  if (!head || sniffImage(head) !== mimeType) return { kind: "refused", reason: "invalid" };
  return { kind: "data", src: `data:${mimeType};base64,${payload}`, mimeType, bytes };
}

function classifyNookPath(path: string, origin: string): ImageTarget {
  if (path.startsWith("//") || path.includes("\\") || /\s/.test(path)) return { kind: "refused", reason: "path" };
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return { kind: "refused", reason: "path" };
  }
  if (url.origin !== origin) return { kind: "refused", reason: "path" };
  for (const [pattern, canonical] of NOOK_IMAGE_ROUTES) {
    const match = pattern.exec(url.pathname);
    if (match) return { kind: "nook", src: canonical(match) };
  }
  return { kind: "refused", reason: "path" };
}

/** What an image source in agent Markdown is, under the rules above. */
export function classifyImage(href: string, origin = pageOrigin()): ImageTarget {
  const value = href.trim();
  if (/^data:/i.test(value)) return classifyData(value);
  if (value.startsWith("/")) return classifyNookPath(value, origin);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "refused", reason: "scheme" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "refused", reason: "scheme" };
  if (url.username || url.password) return { kind: "refused", reason: "scheme" };
  // A full URL on this origin is a Nook path written out.
  if (url.origin === origin) return classifyNookPath(`${url.pathname}${url.search}`, origin);
  if (/\.svgz?$/i.test(url.pathname)) return { kind: "refused", reason: "svg" };
  // A fragment never reaches a server; the proxy refuses URLs that carry one.
  url.hash = "";
  return { kind: "external", url };
}

/** Why an image is not shown, in words for the chip. */
export const REFUSAL_TEXT: Record<ImageRefusal, string> = {
  svg: "SVG images are never shown",
  type: "Only PNG, JPEG, GIF, and WebP images are shown",
  "too-large": `Embedded images are shown up to ${DATA_IMAGE_MAX_BYTES / 1024 / 1024} MiB`,
  invalid: "This embedded image is not valid",
  scheme: "This image address is not one Nook loads",
  path: "Only Nook's own files and pictures load from this Nook"
};

// --- External images: the session's per-chat host consent and the loaded pictures ---

const allowedHosts = new Map<string, Set<string>>();
const consentListeners = new Set<() => void>();

/** Whether the person chose "Always load from <host>" in this chat during this page's life. */
export const hostAllowed = (scope: string, host: string) => allowedHosts.get(scope)?.has(host) === true;
export function allowHost(scope: string, host: string) {
  const hosts = allowedHosts.get(scope) ?? new Set<string>();
  hosts.add(host);
  allowedHosts.set(scope, hosts);
  for (const listener of [...consentListeners]) listener();
}
/** For `useSyncExternalStore`: every card of that host in the chat loads when the person allows it on one. */
export function subscribeImageConsent(listener: () => void) {
  consentListeners.add(listener);
  return () => { consentListeners.delete(listener); };
}
/** Test hook. */
export const resetImageConsentForTests = () => { allowedHosts.clear(); loaded.clear(); };

/** Proxied pictures already loaded (as `data:` URLs), so a re-render or a remount does not fetch again. Bounded. */
const loaded = new Map<string, string>();
const LOADED_MAX = 24;
export const loadedImage = (url: string) => loaded.get(url) ?? null;
function remember(url: string, dataUrl: string) {
  loaded.delete(url);
  loaded.set(url, dataUrl);
  while (loaded.size > LOADED_MAX) loaded.delete(loaded.keys().next().value!);
}

export type ProxyFailure = { ok: false; message: string };
export const PROXY_ERROR_TEXT: Record<string, string> = {
  // The proxy gives one answer for anything that went wrong on the far side (security review M1).
  IMAGE_UNAVAILABLE: "That image could not be loaded",
  URL_REFUSED: "Nook loads outside images only from public https addresses",
  NOT_AN_IMAGE: "SVG images are never loaded",
  RATE_LIMITED: "Too many images loaded; wait a minute",
  AGENTS_DISABLED: "Chat is turned off on this Nook"
};

function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("unreadable"));
    reader.onerror = () => reject(reader.error ?? new Error("unreadable"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Loads an external image through Nook's proxy and returns it as a `data:` URL (the page CSP allows
 * `data:` and Nook's own origin only). The proxy has already checked that the bytes are an image;
 * the type is checked again here before the picture is shown.
 */
export async function loadProxiedImage(url: string, fetcher: typeof fetch = fetch, toDataUrl: (blob: Blob) => Promise<string> = asDataUrl): Promise<{ ok: true; src: string } | ProxyFailure> {
  const cached = loadedImage(url);
  if (cached) return { ok: true, src: cached };
  let response: Response;
  try {
    response = await fetcher(`${IMAGE_PROXY_PATH}?url=${encodeURIComponent(url)}`, { credentials: "same-origin", headers: { [IMAGE_PROXY_HEADER]: "1", Accept: IMAGE_MIME_TYPES.join(",") } });
  } catch {
    return { ok: false, message: "Nook could not be reached" };
  }
  if (!response.ok) {
    let code = "";
    try { code = ((await response.json()) as { code?: string }).code ?? ""; } catch { /* not JSON */ }
    return { ok: false, message: PROXY_ERROR_TEXT[code] ?? (response.status === 429 ? PROXY_ERROR_TEXT.RATE_LIMITED! : "The image could not be loaded") };
  }
  const type = (response.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!IMAGE_MIME_TYPES.includes(type as ImageMimeType)) return { ok: false, message: PROXY_ERROR_TEXT.IMAGE_UNAVAILABLE! };
  try {
    const src = await toDataUrl(await response.blob());
    if (!src.startsWith(`data:${type};`)) return { ok: false, message: PROXY_ERROR_TEXT.IMAGE_UNAVAILABLE! };
    remember(url, src);
    return { ok: true, src };
  } catch {
    return { ok: false, message: "The image could not be loaded" };
  }
}
