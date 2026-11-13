/**
 * Public pages (§B.8, D810): pages under `/p/…`, their JSON under `/api/public/…`, no session. The
 * client's `src/public/PublicApp.tsx` (W1-UI) renders them; modules register the routes
 * (server/public/*). These are the words and numbers both sides need.
 */

/** Kinds of `public_links` (migration 089). */
export const PUBLIC_LINK_KINDS = ["form", "booking_type", "booking_manage", "time_poll_guest", "townhall_session"] as const;
export type PublicLinkKind = typeof PUBLIC_LINK_KINDS[number];

/** The admin policies (team_settings, 085), on by default (§G.1 Q2). */
export const PUBLIC_POLICIES = ["public_forms", "public_booking_pages"] as const;
export type PublicPolicy = typeof PUBLIC_POLICIES[number];

/** A public token: 32 random bytes, base64url (43 characters). Shown once; only its SHA-256 is stored. */
export const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** A booking profile handle (`/p/book/<handle>`): meant to be shared, so readable. */
export const PUBLIC_HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/**
 * What a public page sends back with a submission (every field required):
 * - `nonce`: the signed, single-use render nonce from the page's JSON (`renderNonce`).
 * - `website`: the honeypot; must be empty (a bot fills it).
 * The minimum fill time is read from the nonce's signed render time (3 s forms, 5 s bookings).
 */
export const HONEYPOT_FIELD = "website";
export const NONCE_FIELD = "nonce";
export const MIN_FILL_MS = { form: 3000, booking: 5000 } as const;

/** Body cap of a public submission. */
export const PUBLIC_BODY_MAX_BYTES = 65_536;

/** The uniform body of every public miss (unknown, revoked, expired, policy off, binned, closed). */
export const PUBLIC_NOT_FOUND = { error: "This link is not available", code: "NOT_FOUND" } as const;

/** Email verification of a public submission (§B.8, T577): a 6-digit code. */
export const VERIFICATION_CODE_LENGTH = 6;
export const VERIFICATION_TTL_MS = 30 * 60_000;
export const VERIFICATION_MAX_ATTEMPTS = 5;

/** What a public page JSON carries for the shell (branding). */
export type PublicPageMeta = { appName: string; workspaceName: string; logoUrl: string | null; renderNonce: string };
