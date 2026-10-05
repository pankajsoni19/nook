import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const periodSeconds = 30;

export function encodeBase32(bytes: Uint8Array) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string) {
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];
  for (const character of value.replace(/=+$/g, "").toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid TOTP secret");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function createTotpSecret() {
  return encodeBase32(randomBytes(20));
}

function encryptValue(value: string, key: Buffer, userId: string, purpose: "totp" | "recovery") {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`mynotes:${purpose}:v1:${userId}`));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${nonce.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptValue(encrypted: string, key: Buffer, userId: string, purpose: "totp" | "recovery") {
  const [version, nonceValue, tagValue, ciphertextValue] = encrypted.split(":");
  if (version !== "v1" || !nonceValue || !tagValue || !ciphertextValue) throw new Error("Invalid encrypted TOTP secret");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonceValue, "base64url"));
  decipher.setAAD(Buffer.from(`mynotes:${purpose}:v1:${userId}`));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
}

export const encryptTotpSecret = (secret: string, key: Buffer, userId: string) => encryptValue(secret, key, userId, "totp");
export const decryptTotpSecret = (encrypted: string, key: Buffer, userId: string) => decryptValue(encrypted, key, userId, "totp");

export function createRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const value = encodeBase32(randomBytes(9)).slice(0, 15);
    return value.match(/.{1,5}/g)!.join("-");
  });
}

export const encryptRecoveryCodes = (codes: string[], key: Buffer, userId: string) => encryptValue(JSON.stringify(codes), key, userId, "recovery");
export const decryptRecoveryCodes = (encrypted: string, key: Buffer, userId: string) => {
  const value = JSON.parse(decryptValue(encrypted, key, userId, "recovery"));
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("Invalid recovery-code data");
  return value as string[];
};

export function normalizeRecoveryCode(code: string) {
  return code.replace(/[^A-Za-z2-7]/g, "").toUpperCase();
}

export function recoveryCodeMatches(expected: string, supplied: string) {
  const a = Buffer.from(normalizeRecoveryCode(expected));
  const b = Buffer.from(normalizeRecoveryCode(supplied));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function totpCounter(at = Date.now()) {
  return Math.floor(at / 1000 / periodSeconds);
}

export function totpCodeAt(secret: string, counter: number) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = ((digest[offset] & 127) << 24)
    | ((digest[offset + 1] & 255) << 16)
    | ((digest[offset + 2] & 255) << 8)
    | (digest[offset + 3] & 255);
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret: string, suppliedCode: string, lastCounter: number | null, at = Date.now()) {
  const normalized = suppliedCode.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const supplied = Buffer.from(normalized);
  const current = totpCounter(at);
  for (const counter of [current - 1, current, current + 1]) {
    if (lastCounter !== null && counter <= lastCounter) continue;
    const expected = Buffer.from(totpCodeAt(secret, counter));
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return counter;
  }
  return null;
}

export function totpUri(secret: string, email: string) {
  // Wave 39: APP_NAME names the entry in the authenticator app; a colon would split the label.
  const issuer = config.appName.replace(/:/g, " ");
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${periodSeconds}`;
}
