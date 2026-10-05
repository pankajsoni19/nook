import { api } from "../api";
import { appName } from "../appName";

/**
 * Browser side of Web Push (D65). The service worker is registered, and permission is asked for,
 * only when the user clicks "Enable on this device". Sign-out forgets this device and
 * unregisters the worker (T69).
 */

export type PushConfig = { enabled: true; publicKey: string } | { enabled: false; reason: "insecure_origin" | "disabled" };
export type PushDevice = { id: string; label: string; createdAt: string; lastSuccessAt: string | null; disabled: boolean };

export const getPushConfig = () => api<PushConfig>("/push/config");
export const listPushDevices = () => api<{ subscriptions: PushDevice[] }>("/push/subscriptions");
export const removePushDevice = (id: string) => api<{ ok: true }>("/push/subscriptions", { method: "DELETE", body: JSON.stringify({ id }) });
export const sendTestPush = () => api<{ ok: true; sent: number; failed: number }>("/push/test", { method: "POST", body: "{}" });

export type Environment = { userAgent: string; standalone: boolean; hasServiceWorker: boolean; hasPushManager: boolean; hasNotification: boolean; secure: boolean };

function environment(): Environment {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const win = typeof window === "undefined" ? null : window;
  return {
    userAgent: nav?.userAgent ?? "",
    standalone: Boolean(win && (win.matchMedia?.("(display-mode: standalone)").matches || (nav as Navigator & { standalone?: boolean } | null)?.standalone)),
    hasServiceWorker: Boolean(nav && "serviceWorker" in nav),
    hasPushManager: Boolean(win && "PushManager" in win),
    hasNotification: Boolean(win && "Notification" in win),
    secure: Boolean(win?.isSecureContext)
  };
}

export const isIos = (userAgent: string) => /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && /Mobile/.test(userAgent));

export type PushAvailability =
  | { available: true }
  | { available: false; reason: "server_insecure" | "server_disabled" | "ios_home_screen" | "unsupported" };

/** Whether this device can enable push, and if not, why (drives the explanation copy). */
export function pushAvailability(config: PushConfig | null, env: Environment = environment()): PushAvailability {
  if (config && !config.enabled) return { available: false, reason: config.reason === "disabled" ? "server_disabled" : "server_insecure" };
  if (!env.secure) return { available: false, reason: "server_insecure" };
  // iOS offers Web Push only to web apps added to the Home Screen.
  if (isIos(env.userAgent) && !env.standalone) return { available: false, reason: "ios_home_screen" };
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return { available: false, reason: "unsupported" };
  return { available: true };
}

/** A short device name from the user agent, such as "Chrome on Android". Never sent anywhere but Nook. */
export function deviceLabel(userAgent: string) {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  const system = /Android/.test(userAgent) ? "Android" : isIos(userAgent) ? "iOS" : /Windows/.test(userAgent) ? "Windows" : /Mac OS X|Macintosh/.test(userAgent) ? "macOS" : /Linux/.test(userAgent) ? "Linux" : "";
  return system ? `${browser} on ${system}` : browser;
}

/** The VAPID public key as the byte array PushManager.subscribe expects. */
export function applicationServerKey(publicKey: string) {
  const base64 = publicKey.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(publicKey.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

const sameKey = (subscription: PushSubscription, key: Uint8Array) => {
  const current = subscription.options?.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((value, index) => value === key[index]);
};

/** Registers the worker, asks for permission (this click only), subscribes, and tells Nook. */
export async function enablePushOnThisDevice(config: Extract<PushConfig, { enabled: true }>) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? `Notifications are blocked for ${appName()} in this browser's settings.` : "Notifications were not allowed.");
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const key = applicationServerKey(config.publicKey);
  let subscription = await registration.pushManager.getSubscription();
  // The server's key changed (keys were lost and recreated): subscribe again.
  if (subscription && !sameKey(subscription, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const body = { ...subscription.toJSON(), label: deviceLabel(navigator.userAgent) };
  return api<{ subscription: PushDevice }>("/push/subscriptions", { method: "POST", body: JSON.stringify(body) });
}

/** The endpoint of this device's subscription, if push is on here. */
export async function currentEndpoint() {
  if (!environment().hasServiceWorker) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  return subscription?.endpoint ?? null;
}

/**
 * Sign-out (T69): removes this device's subscription from Nook while the session still works,
 * then unsubscribes and unregisters every Nook service worker. Best effort; never throws.
 */
export async function forgetThisDevice() {
  try {
    if (!environment().hasServiceWorker) return;
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      const subscription = await registration.pushManager?.getSubscription().catch(() => null);
      if (subscription) {
        await api("/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => undefined);
        await subscription.unsubscribe().catch(() => undefined);
      }
      await registration.unregister().catch(() => undefined);
    }
  } catch {
    // Nothing to clean up on this device.
  }
}
