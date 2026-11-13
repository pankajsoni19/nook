import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";

/**
 * The workspace modules' server secret (D810): one 32-byte key in DATA_DIR (`workspace.key`, 0600),
 * made on first use. It signs public render nonces, salts the IP hashes of the public submissions log,
 * keys anonymous one-per-person hashes (D843), and signs the "stop emails" tokens of outside mail (which
 * carry keyed hashes, never an internal id, §B.7). Losing it only invalidates open nonces and stop
 * links; nothing stored depends on it for reading.
 */

const KEY_FILE = "workspace.key";
let cached: Buffer | null = null;

export function workspaceKey(): Buffer {
  if (cached) return cached;
  const path = join(config.dataDir, KEY_FILE);
  if (existsSync(path)) {
    const stored = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (stored.length !== 32) throw new Error(`${KEY_FILE} is not a 32-byte key`);
    cached = stored;
    return stored;
  }
  const key = randomBytes(32);
  writeFileSync(path, `${key.toString("base64")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  cached = key;
  return key;
}

/** A keyed hash for a purpose (labels keep the uses apart), hex, 64 characters. */
export const keyedHash = (purpose: string, value: string) => createHmac("sha256", workspaceKey()).update(`${purpose}\u0000${value}`).digest("hex");

/** An HMAC signature (base64url, 16 bytes) of `payload` for `purpose`. */
export const sign = (purpose: string, payload: string) => createHmac("sha256", workspaceKey()).update(`${purpose}\u0000${payload}`).digest().subarray(0, 16).toString("base64url");

export function signatureMatches(purpose: string, payload: string, signature: string) {
  const expected = Buffer.from(sign(purpose, payload), "base64url");
  const supplied = Buffer.from(signature, "base64url");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** A signed, URL-safe token for `payload` (base64url body, then its signature). */
export const signedToken = (purpose: string, payload: string) => {
  const body = Buffer.from(payload, "utf8").toString("base64url");
  return `${body}.${sign(purpose, body)}`;
};

/** The payload of a signed token, or null when it is not one of ours. */
export function readSignedToken(purpose: string, token: string): string | null {
  if (typeof token !== "string" || token.length > 600) return null;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  return signatureMatches(purpose, body, signature) ? Buffer.from(body, "base64url").toString("utf8") : null;
}

/** Test hook: a fresh random value (keeps randomBytes in use for callers that need one). */
export const randomToken = (bytes = 18) => randomBytes(bytes).toString("base64url");
