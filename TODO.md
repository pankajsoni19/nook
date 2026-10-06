# Nook implementation tracker

Only open work lives here. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new") and `git log`. Plans of record: `DEVELOPMENT_PLAN.md` and `docs/plan/research/`. Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-07):** production runs **v0.30.0** (`a30e684`, Agentic chat AC-E knowledge bases; backup `mynotes-20261006T190706Z.tar.gz`). The agentic chat plan (AC-A…AC-E) is complete. Released migrations are immutable: **001–042**. Messages takes **043**.

## In flight

Nothing. Waiting for the operator's next pick.

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
- [ ] **Chat policy panel (1280):** the "Who can create agents" checkboxes sit well below their label (they align with the taller input in the next column).
- [ ] **Scroll audit:** no dedicated routes yet for the Knowledge Share… and Move to Bin dialogs (both use shared components).
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

## Standing rules for agent briefs

- Subagents run on Opus 5.5 at medium effort, each in its own worktree with pre-assigned ports and migration ids. Releases are serial.
- Never stop processes by name or pattern (no pkill/killall); stop only your own pids. Production and QA containers run `bun server/index.ts` as the same host user.
- Browser QA uses its own `<lane>.localhost:<port>` origin and its own tab or profile, because the session cookie is shared across localhost ports.
- Tests that spawn `bun` use `--no-env-file`. The Docker verify image has no `docs/` and no `git`: guard with `test.skipIf` / `Bun.which`. Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests.
