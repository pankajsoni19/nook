/**
 * Wave 39: APP_NAME in the files the browser and link previews read before any script runs. When the
 * name is not "Nook", index.html (title, application-name, og:/twitter: titles and descriptions, the
 * boot-fallback lines), the web app manifest (name, short_name), and the service worker's generic
 * notification title are served with the name put in. Only those exact places change: script and
 * stylesheet URLs, og:image, its alt text (the picture says Nook), and the CSP are left alone.
 * The name is HTML-escaped in HTML, and JSON-encoded in the manifest and the worker. Every substitution
 * is a function replacement, so `$` sequences in a name are never read as replacement patterns.
 */

export const BRAND_DEFAULT = "Nook";

/** The served paths whose bytes depend on the app name. */
export const BRANDED_PATHS = new Set(["/index.html", "/manifest.webmanifest", "/sw.js"]);

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The meta tags whose content names the app (link previews, the tab, installed-app names). */
const NAMED_META = /(<meta\s+(?:name|property)="(?:application-name|apple-mobile-web-app-title|description|keywords|og:site_name|og:title|og:description|twitter:title|twitter:description)"\s+content=")([^"]*)(")/g;

/** index.html with `name` in the title, the naming meta tags, and the boot-fallback lines. */
export function brandIndexHtml(html: string, name: string) {
  const safe = escapeHtml(name);
  // A function replacement: `$&`, `$$`, and "$`" in a name are kept literally, not read as patterns.
  const swap = (text: string) => text.replace(/\bNook\b/g, () => safe);
  return html
    .replace(NAMED_META, (_match, head: string, content: string, tail: string) => `${head}${swap(content)}${tail}`)
    .replace(/<title>([^<]*)<\/title>/, (_match, title: string) => `<title>${swap(title)}</title>`)
    .replace(/(<p>)Nook( did not finish loading| needs JavaScript)/g, (_match, open: string, rest: string) => `${open}${safe}${rest}`);
}

/** The short name a home screen shows under the icon: the name when it fits 12 characters, else its first word, else a cut. */
export function shortAppName(name: string) {
  const chars = [...name];
  if (chars.length <= 12) return name;
  const first = name.split(/\s+/)[0] ?? "";
  if (first && [...first].length <= 12) return first;
  return chars.slice(0, 12).join("").trimEnd();
}

/** The manifest with `name` and `short_name` set; anything unreadable is served as it is. */
export function brandManifest(text: string, name: string) {
  try {
    const manifest = JSON.parse(text) as Record<string, unknown>;
    return `${JSON.stringify({ ...manifest, name, short_name: shortAppName(name) }, null, 2)}\n`;
  } catch {
    return text;
  }
}

/** The service worker with the generic notification title naming the app. */
export function brandServiceWorker(text: string, name: string) {
  return text.replace(/const GENERIC_TITLE = "You have a new notification in Nook";/, () => `const GENERIC_TITLE = ${JSON.stringify(`You have a new notification in ${name}`)};`);
}

/** The branded text of a served path, or null when it does not depend on the name. */
export function brandFile(servedPath: string, text: string, name: string) {
  if (name === BRAND_DEFAULT) return null;
  if (servedPath === "/index.html") return brandIndexHtml(text, name);
  if (servedPath === "/manifest.webmanifest") return brandManifest(text, name);
  if (servedPath === "/sw.js") return brandServiceWorker(text, name);
  return null;
}
