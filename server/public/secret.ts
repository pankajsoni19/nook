import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";

/**
 * The workspace modules' server secret (D810): one 32-byte key in DATA_DIR (`workspace.key`, 0600),
 * made on first use. It signs public render nonces, salts the IP hashes of the public submissions log,
 * keys anonymous one-per-person hashes (D843), and seals the "stop emails" tokens of outside mail so
 * they never carry an internal id in the clear (§B.7). Losing it only invalidates open nonces and
 * stop links; nothing stored depends on it for reading.
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

/** Seals text (AES-256-GCM under a key derived for `purpose`) into a URL-safe token. */
export function seal(purpose: string, text: string): string {
  const key = createHmac("sha256", workspaceKey()).update(`seal\u0000${purpose}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

/** The text a sealed token holds, or null when it is not one of ours. */
export function unseal(purpose: string, token: string): string | null {
  if (typeof token !== "string" || token.length > 600 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const raw = Buffer.from(token, "base64url");
  if (raw.length < 29) return null;
  try {
    const key = createHmac("sha256", workspaceKey()).update(`seal\u0000${purpose}`).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
