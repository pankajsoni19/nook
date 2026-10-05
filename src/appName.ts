import { useSyncExternalStore } from "react";

/**
 * The app's display name (Wave 39, APP_NAME). The server writes it into index.html's
 * `<meta name="application-name">`, so the very first paint already has it; `/api/about` confirms it
 * (and is the only source in development, where Vite serves index.html as it is). "Nook" until then.
 * Product terms such as "Nook keys" keep their name; titles and the app's chrome use this one.
 */
export const DEFAULT_APP_NAME = "Nook";

function initialName() {
  try {
    const value = typeof document === "undefined" ? "" : document.querySelector('meta[name="application-name"]')?.getAttribute("content")?.trim() ?? "";
    return value || DEFAULT_APP_NAME;
  } catch {
    return DEFAULT_APP_NAME;
  }
}

let current = initialName();
const listeners = new Set<() => void>();

/** The current app name. */
export const appName = () => current;

/** Takes the name from the server (`/api/about`'s `appName`); the tab title follows when it named the old one. */
export function setAppName(name: string | null | undefined) {
  const next = typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : DEFAULT_APP_NAME;
  if (next === current) return;
  const previous = current;
  current = next;
  if (typeof document !== "undefined") {
    const title = document.title;
    const at = title.lastIndexOf(previous);
    if (at >= 0) document.title = `${title.slice(0, at)}${next}${title.slice(at + previous.length)}`;
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** The app name in a component; re-renders when the server's answer differs from the first guess. */
export const useAppName = () => useSyncExternalStore(subscribe, appName, appName);
