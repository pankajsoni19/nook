/**
 * The fixed vocabulary of recognised devices (server/signInDevices.ts, migration 043): a browser
 * family and an OS family read from the User-Agent, and how a sign-in happened. Only these codes are
 * stored or mailed, never the User-Agent string, so every label is built from the lists below. A leaf
 * module: the mail templates and the bell import it without importing the sign-in code.
 */

export const BROWSERS = { firefox: "Firefox", chrome: "Chrome", edge: "Edge", safari: "Safari", opera: "Opera", samsung: "Samsung Internet", other: "Browser" } as const;
export const SYSTEMS = { windows: "Windows", macos: "macOS", linux: "Linux", android: "Android", ios: "iOS", chromeos: "ChromeOS", other: "" } as const;
export type BrowserFamily = keyof typeof BROWSERS;
export type OsFamily = keyof typeof SYSTEMS;

/** The coarse families of a User-Agent: browser and OS only. The string itself is never kept. */
export function deviceFamilies(userAgent: string | null | undefined): { browser: BrowserFamily; os: OsFamily } {
  const ua = (userAgent ?? "").slice(0, 512);
  const browser: BrowserFamily = /SamsungBrowser\//.test(ua) ? "samsung"
    : /\bEdg(e|A|iOS)?\//.test(ua) ? "edge"
    : /\bOPR\/|\bOpera\b/.test(ua) ? "opera"
    : /\bFirefox\/|\bFxiOS\//.test(ua) ? "firefox"
    : /\bChrome\/|\bCriOS\/|\bChromium\//.test(ua) ? "chrome"
    : /\bSafari\//.test(ua) && /\bVersion\//.test(ua) ? "safari"
    : "other";
  const os: OsFamily = /Windows/.test(ua) ? "windows"
    : /Android/.test(ua) ? "android"
    : /iPhone|iPad|iPod/.test(ua) ? "ios"
    : /CrOS/.test(ua) ? "chromeos"
    : /Mac OS X|Macintosh/.test(ua) ? "macos"
    : /Linux|X11/.test(ua) ? "linux"
    : "other";
  return { browser, os };
}

const isBrowser = (value: string): value is BrowserFamily => Object.hasOwn(BROWSERS, value);
const isOs = (value: string): value is OsFamily => Object.hasOwn(SYSTEMS, value);

/** "Firefox on Linux", "Firefox", "Browser on Linux", or "Unknown device". Built only from the fixed lists. */
export function deviceLabel(browser: string, os: string) {
  const b = isBrowser(browser) ? browser : "other";
  const o = isOs(os) ? os : "other";
  if (b === "other" && o === "other") return "Unknown device";
  if (o === "other") return BROWSERS[b];
  return `${BROWSERS[b]} on ${SYSTEMS[o]}`;
}

/** The label from a stored `browser:os` code pair (the bell notice keeps the codes, never text). */
export function deviceLabelFromCode(code: string | null) {
  const [browser = "other", os = "other"] = (code ?? "").split(":");
  return deviceLabel(browser, os);
}

export type SignInMethod = "password" | "password_totp" | "password_recovery" | "google" | "google_totp" | "google_recovery";
export const SIGN_IN_METHODS: Record<SignInMethod, string> = {
  password: "Password",
  password_totp: "Password and two-factor code",
  password_recovery: "Password and a recovery code",
  google: "Google",
  google_totp: "Google and two-factor code",
  google_recovery: "Google and a recovery code"
};
export const isSignInMethod = (value: unknown): value is SignInMethod => typeof value === "string" && Object.hasOwn(SIGN_IN_METHODS, value);
