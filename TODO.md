# Nook implementation tracker

Only open work lives here. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new") and `git log`. Plans of record: `DEVELOPMENT_PLAN.md` and `docs/plan/research/`. Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-06):** production runs **v0.28.0** (Agentic chat AC-C). Released migrations are immutable: **001–040**. Unreleased: **041** `agent_sharing` (on main), **042** `knowledge` (branch `wave44-fixes`). Messages takes **043**.

## In flight

- [ ] **v0.29.0** — merged on main:
  - Agentic chat **AC-D** (sharing, public links, live updates stream, keep-alive for long requests)
  - Settings → AI tabs
  - Settings → API keys tabs
  - vault protected writes (no re-auth to save values)
  - emoji picker for agents
  - shared button and field styles

  Still to do:
  - merge `fix-vault-again-button` (dialog scroll, footer buttons, Vault settings width, chat empty state); its agent is resolving the conflicts with main
  - check the Vault access page wheel failure at 1280×800 (pre-existing?)
  - one combined verification QA, then release
- [ ] **v0.30.0 — Agentic chat AC-E (knowledge bases)**, branch `wave44-fixes` (beff496, includes main b679ea0):
  - Review and QA are done (no HIGH); the fix pass is done, including the operator decision "attaching a base needs manage".
  - Verification is running on `wave44-verify`.
  - Before release, merge main again and add a THREAT_MODEL line for review L4: keyword search scans the FTS index of all bases, then filters.

## Next features (operator to pick)

- [ ] **Messages module** (Slack-like: channels, DMs, threads, notes tab, webhooks, unfurl, reactions). The plan is ready: `docs/plan/research/2026-09-30-messages-module.md`, migration 043. Waiting for the operator's go-ahead.
- [ ] **AC-E deferred:**
  - changing a knowledge base's model or dimensions after creation
  - per-source chunk previews
  - knowledge bases in Team → Groups
  - a search-specific rate limit for keys
  - a hook for group-membership changes (search re-checks access today, so this is not a leak)
  - a Re-index-all limit that survives a restart (it is kept in memory)
- [ ] **Email "later" items** (`docs/plan/research/2026-09-28-outbound-email.md`): a "new sign-in" security mail (needs device info Nook doesn't store), and a welcome mail.

## Small UI follow-ups

- [ ] **Team pane:** the desktop right pane can be taller than the window. Its heading hides under the header after scrolling, and Tab can focus a control below the window on Invites.
- [ ] **Home/Today header:** it scrolls away, while every other module keeps its header.
- [ ] **Keyboard scrolling:** End/PageDown don't scroll the Files list or grid, or a long note body.
- [ ] **Phone sizing:**
  - the note toolbar's "Publish version" is 34 px tall
  - the Tasks/Collections header takes 3 rows
  - the Vault header wraps the bell at 390 px
  - the whiteboard editor-load Retry button is cramped
- [ ] **Phone Back:** after deleting the open note from the list, Back shows the Folders panel where the editor step was.
- [ ] **Stray 404:** opening a member page logs a 404 for `/api/team/<id>/google` while Google sign-in is off.
- [ ] **Guest sharing:** an Access sheet already open when guest sharing is turned off keeps offering guests until reopened.
- [ ] **Bell:** deep links into items.
- [ ] **Member access page:** per-feed revoke and per-routine pause.
- [ ] **Card activity:** still draws letters.
- [ ] **Settings polish:**
  - "Google sign-in is linked" wording on an integration page
  - focus ring on a script-focused heading
  - duplicated H3 on account sections
- [ ] **Settings → AI tabs:**
  - all three share the browser title "Settings · AI" (the API keys tabs have one title per tab)
  - the phone header back arrow on a second tab goes to the list; match the API keys page (`hubBackSteps`)
- [ ] **README:** the link to `#rate-limits-and-reverse-proxies` lands at the page top (it is a bold paragraph, not a heading).

## Known LOW leftovers

- [ ] **Agentic chat:**
  - a Basic-auth-wrapped Nook key in a tool-server credential isn't detected
  - the ACCESS_REVOKED text is hidden while the chat role is removed
  - the chat 503 lacks `Retry-After`
  - provider-reported usage is charged in full when a reply is cut
  - an `?after` overflow sends a terminal snapshot without a separate `done`
- [ ] **Vault:**
  - `Retry-After` underestimates the sliding window (limits.ts)
  - group grants are unnamed in Activity
  - the key volume alert shows twice in a key's Recent activity, and its count isn't shown in the UI
- [ ] **Whiteboards:**
  - search rows indexed from older notes keep an embedded board's name until the note changes
  - the dark-theme colour shift of pictures is accepted (Excalidraw filter)

## Reliability watch

- [ ] `tests/agentsReview.test.ts:351` returned 409 instead of 201 once in a full run (2026-10-06); give it its own agent/chat if it recurs.
- [ ] `tests/calendarFeeds` "with TOTP required…" hit its 5 s timeout once in Docker verify under load; watch on release builds.

## Operator to-do (cannot be done by agents)

- [ ] Set `AGENT_SECRETS_KEY` (Chat is off in production until then).
- [ ] Set `VAULT_ENCRYPTION_KEY` (the Vault is off until then).
- [ ] **Google sign-in:**
  - create the OAuth client (redirect `APP_ORIGIN/api/auth/google/callback`)
  - set `AUTH_METHODS`, linking existing accounts in `both` before switching to `google`
  - set `GOOGLE_ALLOWED_DOMAINS`
  - the first real Google round trip is untested
- [ ] **Behind a proxy:**
  - set `TRUSTED_PROXY_HOPS`, plus `TRUSTED_PROXY_ADDRESSES` (or bind port 2026 to localhost) when hops ≥ 1
  - firewall port 2026
- [ ] **Email:** set `RESEND_API_KEY`, `MAIL_FROM` and optionally `RESEND_WEBHOOK_SECRET`.
- [ ] **Registration:** choose open or invite-only (open registration is on today).
- [ ] **Real-phone checks:**
  - the system Back gesture
  - the on-screen keyboard
  - online/offline events
  - whiteboards and chat on a real device

## Standing rules for agent briefs

- Subagents run on Opus 5.5 at medium effort, each in its own worktree with pre-assigned ports and migration ids. Releases are serial.
- Never stop processes by name or pattern (no pkill/killall); stop only your own pids. Production and QA containers run `bun server/index.ts` as the same host user.
- Browser QA uses its own `<lane>.localhost:<port>` origin and its own tab or profile, because the session cookie is shared across localhost ports.
- Tests that spawn `bun` use `--no-env-file`. The Docker verify image has no `docs/` and no `git`: guard with `test.skipIf` / `Bun.which`. Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests.
