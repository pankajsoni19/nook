import { createHmac, randomBytes } from "node:crypto";
import { workspaceKey } from "../public/secret";

/**
 * The audience link's token, re-derivable (D1076): a public link stores only its token's hash, but a
 * townhall host must show the same QR code again (the presenter view, a second device). So the token
 * is not random-and-forgotten but an HMAC of the session id and a random seed under the workspace key:
 * the session keeps only the seed (`public_token_seed`), editors re-derive the token on demand, and a
 * new link (or turning it off) replaces the seed, so an old token never works again (T612). No cipher
 * is involved (the vault guard keeps ciphers to the vault).
 */

export const newTokenSeed = () => `v1.${randomBytes(18).toString("base64url")}`;

/** The 43-character token (32 bytes, base64url, PUBLIC_TOKEN_PATTERN) a seed gives for a session. */
export function tokenFromSeed(sessionId: string, seed: string | null): string | null {
  if (!seed || !seed.startsWith("v1.")) return null;
  return createHmac("sha256", workspaceKey()).update(`townhall-public-token\u0000${sessionId}\u0000${seed}`).digest().toString("base64url");
}
