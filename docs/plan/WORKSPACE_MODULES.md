# Workspace modules: Forms & Polls, Time, Goals, Check-ins, CRM, Bookings

Source of truth for six new modules and the shared foundations under them. It is the brief for the build agents (Wave 1 foundations, Wave 2 module lanes, Wave 3 wiring). Read §0 and §F first, then your lane's §D section, §B (the primitives you must use, not rebuild), and §E (design).

**Contents:** [0 Ranges](#0-ranges-names-and-conventions) · [A Research and scope](#a-research-summary-and-committed-scope) · [B Shared primitives](#b-cohesion-architecture-shared-primitives) · [C Integration matrix](#c-cross-module-integration-matrix) · [D Per-module specs](#d-per-module-specifications) (D.0 Foundation, D.1 Forms, D.2 Time, D.3 Goals, D.4 Check-ins, D.5 CRM, D.6 Bookings, D.7 Wave 3) · [E Design](#e-design-and-ux-guidelines) · [F Build plan](#f-build-plan) · [G Open questions](#g-open-questions-for-the-product-owner) · [H Risks](#h-risks)

Base: branch `feat/workspace-modules`, cut from `feat/tasks-keys-dates-estimates-activity` (PR #3: card keys, move between boards, start dates, estimates, card activity, Timeline view). Migrations on that base end at **082**; decisions at **D769**; threats at **T462**. **Reserved for the parallel friendly-URLs lane on PR #3's branch: migrations 083–084, decisions D770–D789, threats T490–T499** ("friendly URLs (D770–D789)": human slug + stable short id; this plan follows that convention, §B.4.4).

## 0. Ranges, names, and conventions

| Block | Lane | Migrations | Decisions | Threats | Module id | Routes | MCP scopes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Foundation (server) | W1-CORE | **085–089** | **D800–D829** | **T500–T514** | — | `/p/*` shell, `/api/links`, `/api/datasets` | — (pre-registers all below) |
| Foundation (UI) | W1-UI | none | **D830–D839** | — | — | — | — |
| Forms & Polls | FORMS | **090–092** | **D840–D869** | **T515–T529** | `forms` | `/forms/<slug>-<sid>`, `/p/f/:token` | `forms:read`, `forms:write` |
| Time tracking | TIME | **093–095** | **D870–D899** | **T530–T539** | `time` | `/time` | `time:read`, `time:write` |
| Goals / OKRs | GOALS | **096–098** | **D900–D929** | **T540–T549** | `goals` | `/goals/<slug>-<sid>` | `goals:read`, `goals:write` |
| Check-ins (standups) | CHECKINS | **099–101** | **D930–D959** | **T550–T559** | `checkins` | `/checkins/<slug>-<sid>` | `checkins:read`, `checkins:write` |
| CRM | CRM | **102–105** | **D960–D999** | **T560–T574** | `crm` | `/crm/contacts/<slug>-<sid>` … | `crm:read`, `crm:write` |
| Bookings | BOOK | **106–109** | **D1000–D1039** | **T575–T594** | `bookings` | `/bookings`, `/p/book/*` | `bookings:read`, `bookings:write` |
| Wiring | W3-WIRE | **110–112** | **D1040–D1059** | **T595–T599** | — | — | — |
| Workspace data in Reports | W3-REPORTS | **113–114** | **D1060–D1069** | **T600–T609** | — | — | — |

Rules that apply to every lane:

- Migrations are append-only and transactional, one file per id (`server/migrations/NNN_name.ts`), each listed in the lane's own registry file (`server/migrations/workspace/<module>.ts`, §B.1). Ids inside a block ascend, and the blocks are concatenated in id order, so the runner's ascending check holds however the lanes merge (a dev database that applied a later block first simply applies the earlier one on its next start); a lane that needs fewer leaves the rest unused (gaps are normal, see 045/054). Nothing is released until Wave 3 integrates, so no renumbering is expected; if one is, the integrator renumbers (as lane ACTIVITY's 067 → 081).
- Decision ids are cited in code comments and docs the way the repo already does (`D713`). A lane writes its decisions into its own section of this file (§D.x "Decisions as built") when it merges; it never edits another lane's section.
- Every write goes through a service function that runs inside one transaction with audit and item activity, so web, MCP, REST v1, agents, and approved proposals behave the same (the D742 pattern).
- Every list is keyset-paged, every text column has a length CHECK, every JSON column `json_valid` plus a byte cap, ids are UUIDv7 (time-ordered) unless stated.
- Tests run with `bun --no-env-file test`; Visual QA at 1585, 1280, 390 px (TODO.md "Standing rules for agent briefs").
- Plain words in the UI: "Forms", "Time", "Goals", "Check-ins", "CRM", "Bookings". Settings → Modules lists them; each can be turned off (not a boundary, T97).

Glossary: **item** = any addressable thing (card, note, form, goal…); **container** = the item that carries sharing (board, calendar, form, goal, contact book…); **WorkRef** = `{ kind, id }` naming an item across modules (§B.4); **PersonRef** = a team user or a contact (§B.3); **question set** = a versioned list of questions (§B.2).

---

## A. Research summary and committed scope

Research is from product knowledge of the leading tools as of late 2026; it informs the scope, it is not a feature-parity promise. Each module lists what leaders share (table stakes), what differentiates, what v1 commits to, and what is explicitly out.

### A.1 Polls & Forms

**Leaders:** Slack Polly / Simple Poll (in-chat polls), Doodle / Rallly (find a time), Google Forms, Microsoft Forms, Typeform, Tally, Formbricks.

**Shared by leaders (table stakes):**
- Question types: short/long text, single/multiple choice, dropdown, rating/stars, linear scale, NPS (0–10), date/time, number, email/phone/URL, yes/no, file upload, matrix/grid, ranking; section breaks and statements.
- Required/optional, validation (length, number range, regex for text), "other" option, shuffled options.
- Conditional logic (show/skip question or section based on earlier answers), jump to section, custom end screen.
- Sharing by link; restrict to the organization; one response per person; anonymous mode; close at a date or after N responses.
- Results: per-question summary charts, individual responses, CSV export, notifications on response.
- Polls: one question, quick create in context (chat/doc), anonymous or named votes, live or hidden-until-closed results, multiple votes, close manually or on a schedule.
- Find-a-time (Doodle/Rallly): proposed slots, yes / if-need-be / no per slot, participants' time zones, organizer picks the final slot and books it.

**Differentiators:** Typeform's one-question-per-screen conversational layout; Tally's document-like editor (type `/` to insert a question) and generous free tier; Formbricks' in-product surveys and open-source self-hosting; hidden fields / URL prefill; calculated scores (quizzes); partial responses; webhooks/integrations that route responses (create a ticket, add to CRM); Microsoft Forms' quiz mode; theming.

**v1 scope (committed):**
- One module, **Forms**, with three kinds: `form` (multi-question form or survey), `poll` (one question, embeddable, live results), `time_poll` (find a time).
- All question types in §B.2 (except signature/payment), required, validation, "Other", shuffle, sections, show-if logic and jump-to-section, end screens, hidden fields prefilled from the URL, scoring (sum of option scores, shown to the owner only).
- A Tally-like editor: a column of question blocks, `/` to insert, drag to reorder, live preview pane on desktop; one-question-per-screen display mode (Typeform-like) as a form setting.
- Audiences: workspace members, chosen people/groups, or **anyone with a public link** (admin policy, off by default).
- One response per person (signed-in), per browser (public, best-effort), or unlimited; allow editing a submitted response (signed-in only); anonymous mode (identity never stored).
- Close at a date, after N responses, or manually; reopen.
- Results: summary per question (bar/pie/NPS gauge/rating distribution/word list), individual responses with prev/next, filters by answer, CSV export, per-response delete.
- **Response actions** (routing): create a task card on a board, create or update a CRM contact (and optional deal), notify people. Configured per form.
- Polls: create from a note (`/poll`), a card comment, a Today quick action, or MCP; embed in notes and card descriptions; anonymous or named; single or multi-vote; results live / after voting / after close; close at a time.
- Time polls: propose slots from a calendar picker (with your busy times shown), participants vote yes/maybe/no in their own zone, organizer finalizes → calendar event with participants invited by email (internal) and a link card for outside people.
- Theming: accent color and cover image within the Nook palette (§E), light card on the public page (§E.6).

**Out of scope (v1):** payments, e-signatures, quizzes with auto-grading shown to respondents, partial-response saving for public respondents, file upload on public forms (members only in v1, T521), webhooks to outside URLs, custom domains, custom CSS, multi-language forms, A/B testing, in-product (embedded on outside websites) widget, response piping into question text beyond the respondent's own earlier answers, CAPTCHA services (we use our own anti-abuse, §B.8).

### A.2 Time tracking

**Leaders:** Toggl Track, Harvest, Clockify, Jira worklogs (plus Tempo).

**Shared:** one running timer per person, start/stop from anywhere (browser extension, task), manual entries, duration parsing (`1h30`, `1.5h`, `90m`), week timesheet grid, projects and clients, billable flag and rates, tags, entry descriptions, summary/detailed reports grouped by project/client/person/tag with date ranges, CSV export, rounding in reports, editing past entries, team view for managers.

**Differentiators:** Harvest's invoicing, budgets, and timesheet approvals; Toggl's calendar view (drag to create, calendar events as suggestions) and idle detection; Clockify's free unlimited users, kiosk, scheduling; Jira's per-issue worklogs with "original/remaining estimate" and time on the issue itself; Tempo's capacity planning.

**v1 scope:**
- A global **timer chip** in the top bar (start, stop, switch, edit running description, attach to a card), one running timer per person, survives reloads and devices (server-side).
- Start a timer from a card (card header ▶, card face hover, `t` on a focused card) and from a goal, contact, deal, or booking.
- Manual entries with the duration parser; edit start/end; split; duplicate; "continue" (start again with the same fields).
- **Week timesheet** (rows = project × work item, columns = days, type durations in cells), **Day calendar view** (entries as blocks beside your calendar events; "Log this event" one click; drag to create/resize).
- Projects (with an optional client = CRM company), billable default, hourly rates (project rate, member rate override), budgets in hours or money with progress, project linked to a board (entries on its cards default to it).
- Tags (per workspace, free text, up to 5 per entry).
- Card integration: card **Time** section (logged total, per-person worklog, progress vs estimate when the board estimates in hours), logged totals on card faces (optional), Timeline bars show logged vs estimate.
- Reports: Summary (grouped by project, client, person, card, tag, day/week/month) and Detailed (entries), billable amounts, rounding (none/6/15/30 min, report-time only), CSV export, saved filters. Feeds Reports and Goals (§B.10, §C).
- Timesheet **approval (light)**: a project manager can lock a person's week (approved entries become read-only for the author; manager can unlock).
- Reminders: optional "you have no time logged today" nudge and "timer running for 8h" alert.

**Out of scope (v1):** invoices, expenses, idle detection, browser extension and desktop apps, GPS/kiosk, capacity planning and scheduling, payroll exports, currency conversion, multiple currencies inside one project, screenshots/activity monitoring (never).

### A.3 Goals / OKRs

**Leaders:** Lattice Goals, Perdoo, Linear Projects & Initiatives, Asana Goals, Weekdone.

**Shared:** objectives with measurable key results (start → target, current), owners, time periods (quarters), company/team/individual levels, parent/child alignment tree, progress roll-up, status/health (on track / at risk / off track), regular check-ins with a note and confidence, progress history chart, linking work (projects/tasks) to goals, goal list filters by period/owner/team, visibility controls.

**Differentiators:** Perdoo's distinction of KPIs (health metrics, ongoing) vs OKRs (change) and strategy map; Asana/Linear automatic progress from linked projects/tasks; Lattice ties goals to reviews and 1:1s; Weekdone's weekly PPP check-in tie-in; Linear's initiatives grouping projects with health updates.

**v1 scope:**
- **Goals** (objectives) with **key results**; goals nest (parent goal) for alignment; levels via an optional team (user group) or person; **periods** (workspace-defined, e.g. "Q1 2027") plus custom start/due dates.
- Key result kinds: number, percent, currency, yes/no, milestone checklist; direction increase/decrease/stay-above/stay-below; weights.
- **Automatic progress sources** (D900s, §D.3): tasks (done/total cards of a board, saved view, tag, or epic; or estimate points done/total), time logged (hours on a time project or card set), CRM (won deal value or count in a pipeline in the period, open pipeline value), Forms (response count, average rating, NPS of a question), Check-ins (average of a numeric/rating question), child goals (weighted average). Manual stays available.
- **Check-ins**: value update + health + confidence (1–10) + note; scheduled reminders to owners (weekly by default); history chart; activity timeline and comments.
- KPI goals: a goal of kind `kpi` with a KR that must stay within bounds and has no end date (Perdoo's KPI idea, kept small).
- Views: **Tree** (alignment), **List** (grouped by period/owner/team, sortable), **Timeline** (bars by period, reusing Tasks Timeline styles), **My goals**. Goal page with KRs, linked work (cards with their status, boards, deals, forms), check-in history, comments.
- Linking: a card, board, sprint, or deal can "contribute to" a goal (work link), shown on the card ("Goal: Grow MRR 20%").
- Close a period: snapshot final scores, mark achieved/missed, optional carry-over.

**Out of scope (v1):** performance reviews, 1:1s, compensation, strategy maps/canvas, OKR scoring rubrics beyond 0–1.0 and percent, goal templates marketplace, cascading auto-creation of child goals, approval workflows for goals.

### A.4 Standups / check-ins

**Leaders:** Geekbot, Range, Standuply, Status Hero, 15Five.

**Shared:** scheduled asynchronous check-ins per team (daily standup, weekly retro/check-in), custom questions, delivery at each participant's local time on chosen weekdays, reminders and a deadline, a report feed of answers grouped by day, "same as yesterday" / prefilled answers, blockers highlighted, skip/out-of-office, participation stats and streaks, reactions and threaded comments on answers, digest emails, mood/pulse questions, anonymous pulse surveys (15Five/Geekbot).

**Differentiators:** Range pulls in work activity (tickets moved, PRs) to prefill "what I did"; Status Hero ties to goals and activity; 15Five's weekly check-in with "high five" and manager review; Standuply's video/voice answers; Geekbot's broadcast to channels and AI summaries.

**v1 scope:**
- **Check-ins** with templates: Daily standup, Weekly check-in (Weekdone PPP: progress/plans/problems), Retro, Pulse (anonymous mood + one question), Custom. Questions from the shared engine (§B.2), with roles: `done`, `plan`, `blockers`, `mood`, `goal_update`.
- Schedule: weekdays + local time, per-participant zone (or fixed zone), deadline after N hours, reminder before deadline; holidays/OOO skip per participant (pause until a date).
- Participants (people and groups) and viewers (access model). Answer in-app (a focused sheet, one question per step on phones), from Today ("Check-in due"), from a notification, or via MCP (`answer_checkin`, so an agent or script can answer for its owner).
- **Range-like prefill**: "What did you do" suggests the cards you moved to done, commented on, or logged time on since your last answer (pick to include as card chips); "Plan" suggests your cards due/started today and yesterday's plan.
- **Blockers**: the blockers answer can reference cards (`MYT-12` or picker); those cards get a "Blocked (check-in)" flag + link; blockers are listed at the top of the round.
- **Goal updates**: an optional question lets participants check in on their key results inline (writes goal check-ins).
- Round report: answers grouped by person (or by question), reactions, comment threads, participation (answered/late/skipped/out), mood trend; streaks per person.
- Digest: when a round closes, followers get a summary (inbox notification + optional email); optional "Post to a note" (appends the round to a chosen note as a published version) — Wave 3.
- Pulse: anonymous, aggregated only (minimum 3 answers before results show, T553).

**Out of scope (v1):** video/voice answers, Slack/Teams delivery, AI summaries (Wave 3+ via agents, optional), manager review workflows and 1:1 agendas, public check-ins.

### A.5 CRM-lite / contacts

**Leaders:** Attio, Twenty, Folk, HubSpot (free CRM), Pipedrive.

**Shared:** contacts (people) and companies with standard fields and custom fields; dedupe by email/domain; lists/segments and saved views (table, kanban); deals in pipelines with stages, value, expected close, probability, owner; activity timeline per record (notes, calls, meetings, emails, tasks); follow-up reminders; CSV import/export with field mapping; search; relationships (contact ↔ company ↔ deal); team sharing; reporting (pipeline value, won/lost, conversion by stage).

**Differentiators:** Attio/Twenty's flexible data model (custom objects, relations, spreadsheet-like views), Folk's lightweight relationship-centric lists and enrichment, HubSpot's marketing/email tracking and forms, Pipedrive's activity-driven sales flow ("next activity" on every deal, rotting deals), email/calendar sync with automatic interaction capture.

**v1 scope:**
- **Contact books** (the sharing container; e.g. "Sales", "Hiring", "Personal") holding **contacts** and **companies**, with built-in fields and book-level custom fields reusing the Collections field engine (text, number, date, checkbox, select, multi-select, URL) plus `person` (team member) and `contact` relations.
- Dedupe: unique email per book, company by domain; "possible duplicate" banner; merge two contacts/companies.
- **Pipelines** with stages (open/won/lost, probability), **deals** (value, currency, expected close, owner, contacts, company, next step + date), a **deal board** (kanban with drag between stages, stage totals and weighted totals) and table; rotting indicator (no activity for N days per stage).
- **Interactions**: log note, call, meeting, email, message on a contact/company/deal with a date; bookings and form responses add interactions automatically; record timeline = interactions + activity + linked items (cards, events, bookings, responses, time).
- **Follow-ups**: "Remind me" on any record (inbox notification at a time) or "Create task" (card on a chosen board, linked).
- Lists (static) and saved views with filters (field, stage, owner, tags, last interaction), table and board views; CSV import with mapping and dedupe preview; CSV export; vCard export of a contact.
- Reports datasets: pipeline by stage, won/lost over time, deal velocity, interactions per owner.

**Out of scope (v1):** email sync/sending from the CRM (mailboxes), email tracking, enrichment from outside services, marketing campaigns/sequences, quotes/products/line items, custom objects beyond contacts/companies/deals, multi-currency conversion, lead scoring, territory rules, phone dialer.

### A.6 Bookings

**Leaders:** Cal.com, Calendly, SavvyCal, Google Calendar appointment schedules.

**Shared:** a public booking page per person with event types (title, duration(s), location, description), weekly availability with date overrides, time-zone-aware slots, buffers before/after, minimum notice, booking window, daily limits, conflict checking against calendars, intake questions, confirmation and reminder emails with calendar invites (ICS), reschedule/cancel links, team scheduling (round-robin, collective), one-off/secret links, manual approval option.

**Differentiators:** SavvyCal's overlay of the booker's calendar and ranked availability; Cal.com's open source, workflows, routing forms, seats; Calendly's routing and integrations; Google's built-in simplicity tied to the calendar; payments for paid sessions.

**v1 scope:**
- **Booking profile** per person (`/p/book/<handle>`), **booking types** (title, slug, durations, location: in person / phone / video link / custom / ask the booker, description, color, intake questions from §B.2).
- **Availability schedules** (weekly hours per day, multiple ranges, zone) with date overrides and holidays; per-type schedule choice.
- Conflict checking against chosen Nook calendars (including recurring events; all-day events optional); buffers, minimum notice, max days ahead, slot interval, daily/weekly limits.
- **Team types**: round-robin (least recently booked, with priority and availability), collective (all hosts free).
- Confirmation: automatic or manual approval (pending → host approves/declines).
- On booking: create the event in the host's chosen calendar (with the booker and answers), **upsert the booker as a contact** in the chosen contact book and log a meeting interaction, optionally create a card (e.g. "Prepare for call with Ana"), notify host(s); email the booker a confirmation with ICS and a manage link (reschedule / cancel), plus reminders (24 h, 1 h configurable).
- Secret one-off links (single use or expiring) for a type; internal booking ("Book time with Priya" from Team/contact pages).
- Bookings list (upcoming, pending, past, cancelled), no-show marking, host-side reschedule/cancel with message.
- Anti-abuse (§B.8): rate limits, per-email caps, optional email verification before confirming, honeypot, minimum fill time.

**Out of scope (v1):** syncing outside calendars (Google/Outlook busy times) — see open question Q1; generating video links (Zoom/Meet APIs); payments; seats/group events; routing forms (Wave 3+ via Forms → booking link); SMS reminders; embedding the booking widget on outside sites (link only); custom domains.

---

## B. Cohesion architecture: shared primitives

Six modules must read as one product. The rule: **if two modules need it, Wave 1 builds it once** and lanes only register into it. Each primitive lists its owner (W1-CORE or W1-UI), its files, and what lanes call.

### B.1 Module registries (lanes add files, they don't edit shared ones)

Today a module touches ~15 shared files (server/index.ts route list, mcpTools.ts spread, mcpScopes.ts, keyGrants.ts, keyResources.ts, moduleIds.ts, src/modules.ts, src/router.ts, src/App.tsx, appShellNavigation.ts, todayApps.ts, searchRoutes.ts, bin.ts types, sweeper.ts, mail/registry.ts). Six parallel lanes editing them would conflict constantly. Wave 1 therefore does two things.

**1. Pre-register every word** the six modules need in the shared vocabularies, once (D800):
- `server/moduleIds.ts` and `src/modules.ts` `MODULE_IDS`: `forms`, `time`, `goals`, `checkins`, `crm`, `bookings` (Settings order after `reports`).
- `server/mcpScopes.ts`: the twelve scopes in §0, implied reads, write classification. `server/keyGrants.ts`: `GRANT_MODULES`, `SCOPE_GRANTS`, `RESOURCE_KINDS` (`form`, `time_project`, `goal`, `checkin`, `contact_book`, `booking_type`). `server/team/roles.ts` role filters: guests get `forms:read`/`forms:write` (responding only) and `checkins:read`/`checkins:write` (answering only), nothing else new; viewers get reads only.
- Migration **085** rebuilds the CHECK-listed tables once with every new word (§D.0): `api_key_grants`, `proposals`, `notifications`, `team_settings`, and recreates `access_grants_v`.

**2. Registries** lanes call from their own folder (W1-CORE unless marked UI):

| Registry | File | Lane calls | Replaces editing |
| --- | --- | --- | --- |
| Server module entry | `server/workspaceModules.ts` imports `server/{forms,time,goals,checkins,crm,bookings}/index.ts` (W1 creates each as an empty stub); server/index.ts calls `mountWorkspaceModules(app)` once | lane fills its own `index.ts`: `registerWorkspaceModule({ id, routes(app), publicRoutes(app), mcpTools, binProviders, todayProviders, searchScopes, datasets, workKinds, itemKinds, scheduleHandlers, progressSources, mailTemplates, proposalKinds, agentTools, digestSections })` | server/index.ts, mcpTools.ts, sweeper.ts, searchRoutes.ts |
| Migrations | `server/migrations/workspace/index.ts` concatenates `foundation.ts`, `forms.ts`, `time.ts`, `goals.ts`, `checkins.ts`, `crm.ts`, `bookings.ts`, `wiring.ts`, `reportsWorkspace.ts` (each `Migration[]`, `[]` at first except foundation) | lane appends to its own file | migrations/index.ts (W1 adds one spread line) |
| MCP tools | `server/mcpRegistry.ts` `registeredToolSpecs()` spread into `mcpToolSpecs` | via `registerWorkspaceModule({ mcpTools })` | mcpTools.ts |
| Item kinds (key grants) | `server/keyResources.ts` gains `registerItemKind(kind, lookup, anchorKinds)` | lane registers `form`, `response`, `goal`, … | keyResources.ts LOOKUPS |
| Agent allowlist | `server/agents/nookBridge.ts` gains `registerAgentTools(allowed, never)` | lane classifies its tools | nookBridge.ts sets |
| Proposal kinds | `server/inbox/kinds.ts` gains `registerProposalKind(kind, def)` (words pre-allowed by 085) | lanes register `time_log`, `goal_checkin`, … | kinds.ts |
| Bin types | `ProvidedBinType` widened by W1; `registerBinProvider` exists | lane registers | bin.ts |
| Today sections | `registerTodayProvider` exists | lane registers | — |
| Search | `server/searchRegistry.ts` `registerSearchScope(scope, fn)`; `/api/search` consults it; new `scope=all` | lane registers | searchRoutes.ts |
| Mail templates | `server/mail/registry.ts` gains `registerMailTemplate(name, def)` | lane registers `bookings.confirmed`, … | TEMPLATES object |
| Schedules, datasets, work kinds, progress sources | §B.6, §B.10, §B.4, §D.3 | lane registers | — |
| Client module (UI) | `src/workspaceModules/index.ts` imports `src/{forms,time,goals,checkins,crm,bookings}/module.tsx` (W1-UI stubs, `ready: false`) | lane fills `module.tsx`: `{ id, label, icon, description, ready, app (lazy), parseRoute(segments, search), formatRoute(route), launcher, todaySections, quickActions, topBarItem?, settingsSections?, workKindRenderers, embedRenderers, activityRenderers, searchRenderer }` | src/modules.ts, router.ts, App.tsx, appShellNavigation.ts, todayApps.ts |

`src/modules.ts` spreads `WORKSPACE_MODULE_DEFS` into `MODULES` with `planned: !def.ready`, so a module stays hidden until its lane flips `ready: true` in its own file. `router.ts` gets one generic route shape (`{ app: <moduleId>; path: string[]; search }` delegated to the module's `parseRoute`/`formatRoute`), App.tsx one generic lazy render branch with the standard props (`account`, `role`, `navigate`, `flash`, `onHome`), `AppSection` gains the six ids. What a lane still must touch in shared files is listed per lane in §F.3 as **append-only**, one line each.

### B.2 The question engine (Forms, Polls, Time polls, Check-ins, Booking intake)

One engine defines questions, validates answers, evaluates logic, stores responses, aggregates results. Owner: W1-CORE (`shared/questions/*`, `server/questions/*`) and W1-UI (`src/ui/questions/*`).

**Question set** (`shared/questions/types.ts`): `{ version: 1, questions: Question[], sections: Section[], logic: LogicRule[], endings: Ending[] }`, at most 200 questions, 256 KiB JSON.

```ts
type Question = {
  id: string;            // stable 8-char id, never reused inside a host's sets
  type: QuestionType;
  title: string;         // ≤ 500, inline **bold**/_italic_/links only
  help?: string;         // ≤ 1000
  required?: boolean;
  sectionId?: string;
  role?: "done" | "plan" | "blockers" | "mood" | "goal_update"
       | "contact_name" | "contact_email" | "contact_phone" | "company";   // what other modules read
  options?: Array<{ id: string; label: string; score?: number; color?: string }>; // ≤ 200
  allowOther?: boolean; shuffle?: boolean; minSelect?: number; maxSelect?: number;
  validation?: { minLength?: number; maxLength?: number; min?: number; max?: number; step?: number;
                 pattern?: "email" | "url" | "phone" | "integer" };
  scale?: { min: 0 | 1; max: number; minLabel?: string; maxLabel?: string; icon?: "number" | "star" | "heart" | "emoji" };
  matrix?: { rows: Array<{ id: string; label: string }>; columns: Array<{ id: string; label: string }>; multiple?: boolean };
  slots?: Array<{ id: string; start: string; end: string }>;   // time_slots, UTC ISO, ≤ 100
  allowMaybe?: boolean;                                        // time_slots
  hiddenKey?: string;                                          // hidden: URL parameter name
  prefill?: "last_answer" | "suggest_cards_done" | "suggest_cards_planned"; // check-ins (§D.4)
};
```

**Types** (`QUESTION_TYPES`, table-driven like `CARD_ACTIVITY_KINDS`: a type is one row in shared, one renderer, one aggregator; adding a type later needs no migration):

| Type | Answer value | Aggregation | Public pages |
| --- | --- | --- | --- |
| `short_text`, `long_text` | string (≤ 500 / 10 000) | count, latest list, top words | yes |
| `single_choice`, `dropdown`, `yes_no` | option id (or `other` + text) | counts, % | yes |
| `multi_choice` | option ids | counts, % of respondents | yes |
| `ranking` | ordered option ids | average rank, Borda | yes |
| `rating` (stars/hearts/emoji), `scale` (linear) | integer | distribution, mean, median | yes |
| `nps` | integer 0–10 | promoters/passives/detractors, score | yes |
| `number` | number | min/max/mean/sum, histogram | yes |
| `email`, `phone`, `url` | normalized string | count | yes |
| `date`, `time`, `datetime` | ISO (+ tz) | histogram over time | yes |
| `matrix` | `{ rowId: colId \| colId[] }` | per-row counts (heatmap) | yes |
| `time_slots` | `{ slotId: "yes" \| "maybe" \| "no" }` | yes/maybe per slot, best slot | yes |
| `contact` | `{ name, email?, phone?, company? }` | count | yes |
| `hidden` | string from a URL parameter | counts | yes |
| `file` | document ids (≤ 5, via attachments) | count | **members only** (T516) |
| `person` | user ids | counts | members only |
| `card` | card ids (work refs, keys accepted) | counts | members only |
| `statement` | — (display only) | — | yes |

**Logic** (`shared/questions/logic.ts`): `LogicRule = { id, when: { all | any: Condition[] }, then: { show: id[] } | { hide: id[] } | { jumpTo: sectionId | endingId } }`, `Condition = { questionId, op: "answered" | "not_answered" | "eq" | "neq" | "includes" | "gt" | "lt" | "between", value? }`. Pure; runs on the client (live) and the server (authoritative: answers to hidden questions are dropped; `required` applies to visible questions only). Jumps go forward only (no cycles), checked at save.

**Validation**: `validateAnswers(set, answers, { audience: "public" | "member" })` → per-question errors; members-only types are refused on public submissions.

**Scoring**: `score = Σ option.score` (+ numeric answers flagged `scored`), stored on the response, shown to result readers only.

**Storage** (migration 087): `question_sets` (immutable versions per host), `responses`, `response_answers` (one normalized row per answered value so SQL aggregates directly: choices one row per option, numbers in `value_num`, text in `value_text`). Hosts (`host_kind`): `form`, `checkin`, `booking_type`. A response pins the set version it answered, so editing a live form never corrupts old answers; summaries map by option id (renamed labels show the current label; deleted options show "Removed option").

**Server API** (`server/questions/service.ts`): `saveDraftSet(host, set)`, `publishSet(host)` → version, `currentSet(host)`, `submitResponse({ host, version, subject?, respondent, answers, meta })`, `updateResponse`, `deleteResponse` (undo ticket), `summarize(host, filter)`, `responsesPage(host, filter, cursor)`, `exportCsv(host, filter)` (formula-injection-safe: cells starting with `= + - @` get a leading `'`, T514).

**UI** (W1-UI, `src/ui/questions/`): `<QuestionSetEditor>` (block list, `/` to insert, drag to reorder, per-type settings panel, logic sheet, preview toggle, keyboard: ⌘↑/↓ move, ⌘D duplicate, Backspace on empty title deletes), `<QuestionRenderer mode="page" | "stepper">` (every type; Enter = next, 1–9 pick a choice, arrows on scales), `<ResponseViewer>` (one response, prev/next, J/K), `<QuestionSummary>` (per-type chart via the Reports chart wrapper, §B.10).

### B.3 People: team users, contacts, companies

Two kinds of people, one way to show and pick them.

- **Team users**: `users` rows (people; integrations and service accounts excluded from pickers). Unchanged.
- **Contacts**: external people in a **contact book**. **W1-CORE owns the core tables** (migration 088: `contact_books`, `contacts`, `contact_channels`, `companies`) because Bookings, Forms, and Time write them in Wave 2; CRM owns the UI and everything else (custom-field UI, pipelines, deals, interactions, lists).
- **PersonRef** (`shared/people.ts`): `{ kind: "user"; id } | { kind: "contact"; id } | { kind: "guest"; name; email }` (a guest is an unsaved outsider: a time-poll voter, a booker before upsert).
- **Upsert by email** (`server/people/contacts.ts` `upsertContactByEmail(bookId, { email, name?, phone?, company? }, { source, sourceRef, actor })`): finds by normalized email in the book, else creates; fills only empty fields, never overwrites a human edit (D806); links or creates the company by email domain when the book's "Link companies by domain" setting is on and the domain is not free-mail (`shared/freeMailDomains.ts`). Returns `{ contactId, created }`. Used by Bookings, form actions, MCP, CSV import.
- **Clients for Time** are CRM **companies** (`time_projects.company_id`). With CRM off, Time shows a plain "Client" picker over the same table, in each owner's hidden system book "Clients" (D807), so Time never depends on CRM's UI.
- **UI** (W1-UI): `<PersonChip person>` (avatar/initials, name, contact badge, "Former member", "A contact" when the book is unreadable), `<PersonPicker allow={["user","group","contact"]} bookIds?>` (searches users, groups, readable contacts; inline "Add contact" when allowed), `<CompanyChip>`.
- **Access**: a contact is readable by readers of its book; a contact chip on an item you can read but whose book you cannot shows "A contact" without details (T503).

### B.4 Work links and references

#### B.4.1 Model

`work_links` (086): `(id, a_kind, a_id, b_kind, b_id, relation, created_by, created_via, created_at)`, unique `(a_kind, a_id, b_kind, b_id, relation)`, index `(b_kind, b_id)`. Relations: `relates`, `contributes` (work → goal), `tracks` (time entry → work), `source` (created-from: card ← response, contact ← booking), `blocks` (check-in blocker → card), `mentions` (auto from text). Display direction: "MYT-12 contributes to *Grow MRR*".

Existing link tables stay authoritative for what they cover (card relations, `event_links`, `attachment_links`, card hierarchy); the **resolver** reads them too, so a card's **Linked** panel lists everything. New modules write only `work_links`.

#### B.4.2 Kinds and adapters

`shared/workRefs.ts` `WORK_KINDS`: existing `card`, `board`, `sprint`, `note`, `document`, `whiteboard`, `event`, `calendar`, `collection`, `row`, `report`; new `form`, `response`, `time_entry`, `time_project`, `goal`, `key_result`, `checkin`, `checkin_round`, `contact`, `company`, `deal`, `booking`, `booking_type`. Server adapters (`registerWorkKind`; W1 registers the existing kinds, lanes their own):

```ts
type WorkKindAdapter = {
  kind: WorkKind;
  resolve(ids: string[], viewer: Viewer): Map<string, WorkSummary | null>; // null: unreadable or gone
  level(id: string, viewer: Viewer): ItemLevel;                            // for link rules
  itemKind?: ItemKind;                                                     // for key grants
};
type WorkSummary = { kind; id; shortId?; key?; title; subtitle?; href; icon; status?: { label; tone }; progress?: number; due?: string };
```

#### B.4.3 Rules

- Creating a link needs **edit on side A** and **read on side B**; removing needs edit on either side (card relations' rule, T90).
- A link whose other side the viewer cannot read shows "An item you can't open" with the kind icon only (T501); chosen-item keys see only links with both sides reachable (T203).
- Purge: each lane's migration adds `AFTER DELETE` triggers removing `work_links` rows of its kinds (the `attachment_links` pattern); W1 adds them for existing tables. The Bin keeps links (they come back on restore).
- Every link change writes item activity on both sides (`linked`/`unlinked`; cards via `recordCardItems`).

#### B.4.4 URLs, text refs, embeds

- **URLs follow friendly URLs (D770–D789)**, the shared convention from the parallel lane: a cosmetic human slug plus a stable short id, e.g. `/goals/grow-mrr-20-k7f3q2`, `/crm/contacts/ana-silva-9xk2mm`, `/crm/deals/acme-renewal-3jd8ka`, `/forms/onboarding-survey-a1b2c3`, `/checkins/daily-standup-pp81ze`, `/bookings/types/intro-call-q2w3e4`, `/time/projects/acme-website-r5t6y7`. The short id is authoritative; a wrong or stale slug, or an old UUID URL, resolves and is corrected with `history.replaceState`. Every new top-level table has `short_id` (unique, generated by that lane's helper). If the helper is not merged when Wave 1 starts, W1-CORE vendors the same spec in `shared/shortIds.ts` and W3-WIRE dedupes. Public pages use tokens or handles, never short ids (§B.8).
- **Text refs**: `parseWorkRef(text, origins)` accepts card keys (`MYT-12`), any in-app URL of a registered kind (friendly or UUID), and `kind:id`. Notes, card descriptions/comments, check-in answers, and item comments render recognized refs as chips (client) and record `mentions` links (server, on publish/save; a cache like `content_references`).
- **Embeds** (`shared/embeds.ts`, generalizing the whiteboard embed D208): a line `[<Neutral word>](<path> "nook-embed")` renders a live card. v1 kinds: poll (vote inline), form ("Respond"), time poll, goal (progress), booking type (link card). The link text is always the neutral word ("Poll", "Form", "Goal") so readers never learn a title they cannot open (QA H1 precedent). The note editor's `/` menu and the card description editor get "Poll", "Form", "Goal", "Booking link".

### B.5 Item activity, comments, reactions

- **`item_activity`** (086) generalizes `card_activity` (D740–D746) for new modules: `(id, item_kind, item_id, container_kind, container_id, actor_id, actor_label, via, kind, payload, created_at)`. `shared/itemActivity.ts` holds kinds per module (`registerActivityKinds(module, { kind: { shape, coalesce } })`), snapshot-label payloads, 2-minute coalescing, keyset pages, redaction. Service `recordItemActivity` / `recordItemChange` inside the write's transaction. Cards keep `card_activity` unchanged.
- **`item_comments`** (086): `(id, item_kind, item_id, parent_id, author_id, body_md ≤ 20 000, created_at, updated_at, deleted_at)`, one level of threading, @mentions notify, reactions via the existing `reactions` table (`target_kind = 'item_comment'`; its CHECK is a glob, no migration), files via `attachment_links` (`host_kind = 'item_comment'`). Used by goals, deals, contacts, companies, check-in responses, bookings (internal notes), form responses.
- **UI** (W1-UI): `<ItemTimeline kind id>` = comments and activity interleaved with the D746 controls; modules register renderers (`activityRenderers`, typed so a registered kind must have one).

### B.6 Schedules and reminders engine

One dispatcher for everything that fires on a clock: check-in rounds (open, remind, close), form/poll auto-close, goal check-in reminders, booking reminders and pending expiry, long-running timer alerts, period closes.

- **`schedules`** (089): `(id, purpose, owner_kind, owner_id, user_id, rule_json, tz, next_fire_at, claimed_at, last_fired_at, payload_json, enabled, created_at, updated_at)`. `rule_json` is `{ once: iso }`, `{ cadence }` (`shared/routineSchedule.ts` cadences extended with `weekdays: number[]` and `everyNWeeks`), or `{ rrule }` (`shared/calendarRecurrence.ts`). DST behavior is those helpers'.
- **`schedule_fires`**: `(schedule_id, fire_at, status, finished_at)`, primary key `(schedule_id, fire_at)`: at most once per occurrence, even across a crash (claim → insert fire row → handler in its own transaction → done).
- **Dispatcher** (`server/schedules/dispatcher.ts`): 30 s tick and batch 200 (reminders' constants), per-purpose lateness (`skipIfLateMs`), paused during a backup (as the sweeper), `registerScheduleHandler(purpose, { run(schedule, fireAt), skipIfLateMs })`. Purposes are namespaced (`checkins.open`, `bookings.remind`, …). Service API: `upsertSchedule(owner, purpose, rule, payload)`, `cancelSchedules(owner, purpose?)`, `nextFires(rule, from, n)` (UI previews "Next: Mon 09:00, Tue 09:00").
- Lanes never add their own `setInterval`.

### B.7 Notifications, email, push, inbox

- 085 widens `notifications.kind` with `module` and adds `module`, `topic`, `title` (≤ 200), `body` (≤ 500), `href`, `item_kind`, `item_id`, `actor_id`, `dedupe_key` (unique per user while unread). `server/notify/index.ts`: `notify({ userIds, module, topic, title, body?, href, item?, actor?, dedupeKey?, push = true, email?: { template, payload, coalesceKey? } })` writes the row, sends push, and enqueues mail when the user's prefs allow the topic. The bell and Notifications page render module rows with the module icon (W1-UI).
- **Email prefs**: `email_prefs.categories` gains `forms`, `time`, `goals`, `checkins`, `crm`, `bookings` (JSON keys within the 512-byte CHECK; no schema change). Settings → Notifications lists one row per enabled module.
- **External recipients** (bookers, time-poll guests): `enqueueExternalMail({ to, template, payload, itemRef })` (W1-CORE) uses `mail_outbox.to_address`, honors `mail_suppressions`, caps per address (10/hour, 50/day) and per item, never includes internal ids, adds a "stop emails about this booking" link. With mail not configured it returns `null` and callers show "No email will be sent".
- **Inbox proposals**: lanes register `time_log`, `goal_checkin`, `contact_create`, `contact_update`, `deal_create`, `deal_update`, `interaction_log`, `checkin_answer`, `form_create` (words pre-allowed by 085).
- **Digest**: `registerDigestSection` (W1-CORE) on `server/mail/digest.ts` for "Check-ins you missed", "Goals needing a check-in", "Today's bookings", "Follow-ups due".

### B.8 Public pages, links, anti-abuse

- **`public_links`** (089): `(id, kind, item_id, token_hash UNIQUE, token_prefix, created_by, created_at, expires_at, max_uses, use_count, revoked_at, last_used_at, settings_json)`; kinds `form`, `booking_type` (secret one-off links), `booking_manage` (per booking, for the booker), `time_poll_guest`. Tokens are 32 random bytes base64url (43 chars), shown once, SHA-256 stored (D362/D66 pattern). Booking **profiles** use a public handle (`/p/book/<handle>/<slug>`) because they are meant to be shared; secret links use tokens.
- **Policies** (`team_settings`, 085): `public_forms` and `public_booking_pages`, **off** by default; members and admins create public links when on. Turning one off makes its public routes 404 at once and keeps the rows (D362 behavior).
- **Routes**: pages under `/p/…`, JSON under `/api/public/…`. One middleware (`server/public/middleware.ts`, generalized from `server/agents/publicRoutes.ts`): strict CSP (`form-action 'self'`, `frame-ancestors 'none'`), `no-store`, `noindex`, `no-referrer`, no session cookie read or set, CSRF via a signed per-render nonce, one uniform 404 for unknown/revoked/expired/policy-off/binned/closed-by-module.
- **Limits** (`server/public/limits.ts`): per IP (page GET 120/min; submit 10/min, 60/hour), per link (default 300 submissions/hour), per booker email (3 upcoming per type), per-module pause switch. In-memory buckets (single replica, as today) plus durable per-link counters.
- **Bot defenses without third parties**: honeypot field; minimum fill time (signed render timestamp: 3 s forms, 5 s bookings); single-use signed nonce (no replay); 64 KiB body cap; optional **email verification** for public forms and bookings (6-digit code or link to the given address before the submission counts, T577). IPs are stored only as salted hashes in `public_submissions_log`, kept 30 days.
- **Client**: `src/main.tsx` sends `/p/*` to a lazy `src/public/PublicApp.tsx` before any session code (the `/share/c/` pattern). `<PublicPageShell>` (W1-UI): light card on a neutral background (§E.6), workspace name/logo from branding, "Powered by <app name>", 375 px first.

### B.9 Access and sharing

- Six new **AccessKinds**, levels `view < comment < edit < manage`, owner above: `form`, `time_project`, `goal`, `checkin`, `contact_book`, `booking_type`.
- **One generic member table and one generic group-grant table** for them (085): `item_members(item_kind, item_id, user_id, level, created_at)` and `item_group_grants(item_kind, item_id, group_id, level, granted_by, created_at)` (D803: one rebuild of `access_grants_v` now instead of one per lane; reports took their own tables for the same reason, 052). `server/access/shares.ts` `SHARE_TABLES` gains a discriminator (`kindColumn: "item_kind"`); `effective.ts`, `itemAccess.ts`, Settings → Team → Access, and the Access sheet handle the new kinds.
- Each container has `owner_id`, `visibility` (`private` | `selected` | `all_users`), `share_role` (audience level), like calendars and collections.
- **Responding is not access**: who may answer a form or check-in, or book a type, is a separate `audience`, so "everyone can answer, only HR sees results" is one setting.
- Roles: guests respond to forms/polls shared with them and answer check-ins they take part in; no CRM, Time projects, Bookings admin; Goals read-only if shared. Viewers read.
- Chosen-item keys: containers are `RESOURCE_KINDS`; contents anchor on them via `registerItemKind`: `response → form`, `time_entry → time_project` (entries without a project anchor on nothing: whole-module keys only, T531), `key_result → goal`, `checkin_round → checkin`, `contact | company | deal | interaction → contact_book`, `booking → booking_type`.

### B.10 Datasets: module Insights and Reports

Reports run guarded SQL on **ClickHouse data sources only**; Nook's own SQLite data is not reachable there. Plan:

- **Wave 1: dataset registry** (`server/datasets/registry.ts`, `shared/datasets.ts`). A dataset: `{ id, module, label, description, columns: [{ name, type: "string"|"number"|"date"|"datetime"|"bool"|"money"|"duration", label, dimension?, measures?: ("sum"|"avg"|"count"|"min"|"max"|"count_distinct")[] }], timeColumn, from: SQL, scope(viewer): { sql, params } }`. A **structured query** `{ dataset, measures, dimensions, filters, timeRange, timeBucket: "day"|"week"|"month"|"quarter", sort, limit ≤ 1000 }` compiles to parameterized SQLite with the viewer's access predicate always ANDed in. No free SQL. `POST /api/datasets/query`; MCP `list_datasets` / `query_dataset` (the module's read scope; chosen-item keys narrow via `keyFilter`).
- **Module Insights**: each module has an **Insights** tab of preset queries rendered with `<InsightChart>` / `<KpiTile>` (W1-UI wraps Reports' `charts.tsx`, `chartOption.ts`, `KpiTile.tsx`; theme `shared/reportTheme.ts`).
- **Datasets** (lanes register): `forms.responses`, `forms.answers`; `time.entries`; `goals.key_results`, `goals.kr_values`, `goals.checkins`; `checkins.answers`, `checkins.participation`; `crm.deals`, `crm.deal_stage_changes`, `crm.interactions`, `crm.contacts`; `bookings.bookings`; W1 adds `tasks.cards` and `tasks.card_events` (done-over-time from `card_activity`).
- **Wave 3 (W3-REPORTS): "This workspace" data source** in Reports (§D.7, open question Q3): a data source kind `workspace` whose queries are structured dataset queries stored as JSON instead of SQL, so charts, filters, parameters, schedules, and generation work unchanged.

### B.11 Today / Home

Modules register Today sections, launcher tiles, and **Quick actions** (a new Today row from W1-UI: "Start timer", "New poll", "Log a call", "Copy booking link", "Answer check-in", "Check in on a goal").

| Module | Today sections |
| --- | --- |
| Forms | `formsResponses` (your open forms with new responses), `pollsToVote` (polls shared with you, not voted) |
| Time | `timeToday` (today's total, running timer, "nothing logged yet") |
| Goals | `goalsCheckin` (your goals due a check-in), `goalsAtRisk` |
| Check-ins | `checkinsDue` (rounds open for you) |
| CRM | `crmFollowups` (follow-ups due, deals whose next step is today or rotting) |
| Bookings | `bookingsToday` (today's and tomorrow's, pending approvals) |

### B.12 Search

`registerSearchScope` (W1-CORE) and Ctrl/⌘+K: a new **All** scope (default when opened from the top bar) fans out to every registered scope the user has and merges the top 5 per scope under headers. FTS5 per module, lane-owned (`<module>_fts`, unicode61 remove_diacritics 2 as `collection_row_fts`): form titles/descriptions/question titles; goal titles/descriptions/KR titles; contact names/emails, company names/domains, deal titles, interaction bodies; check-in answers (readers of the round only); booker names/emails and type titles; time entry descriptions. Card keys and short ids resolve directly.

### B.13 Bin, purge, retention

- To the Bin (30 days) via `registerBinProvider`: `form`, `goal`, `checkin`, `contact_book`, `contact`, `company`, `deal`, `time_project`, `booking_type` (words pre-added by W1).
- Fine-grained records are deleted at once with an **Undo** toast (10 s) and an audit row: time entries, responses, interactions, item comments, key results. W1 generalizes `server/attachments/undoTickets.ts` into `server/undo.ts` (capture row(s) → ticket → restore).
- Purge deletes children by FK cascade and removes `work_links`, `item_activity`, `item_comments`, `item_members`, `item_group_grants`, `schedules`, `public_links`, `attachment_links`, reactions through triggers each lane adds. Each lane has a test asserting no orphans after purge (`tests/support/orphans.ts`, W1).
- Bookings are never binned (history); cancelling keeps them. `public_submissions_log` expires after 30 days.

### B.14 Audit

Every write: `audit(actorId, null, "<module>.<event>", metadata)` with ids only (never answer text, contact details, tokens; T505); surface from `auditVia()`. Public submissions audit with actor `null`, `via: "public"`, and the link id. Event names are listed per lane in §D.

### B.15 MCP toolkit advancements

- **One shape for every module**: `list_<things>` (filters, `cursor`, `limit ≤ 100` → `{ items, nextCursor }`), `get_<thing>` (id, short id, URL, or key), `create_<thing>`, `update_<thing>` (partial; optional `expectedRevision` → `CONFLICT`), `delete_<thing>` (Bin where Bin-able; also needs `bin:write`, D172), `search_<module>`, and `bulk_<verb>_<things>` where volume is normal (time entries, contacts, deals): ≤ 100 items, all-or-nothing, `dryRun: true` returns the plan.
- **Cross-module tools** (W1-CORE, `server/mcpWorkTools.ts`): `resolve_ref`, `link_items`, `unlink_items`, `list_links`, `search_workspace`, `list_datasets`, `query_dataset`, `get_item_activity`, `comment_on_item`, `list_item_comments`. Scopes: the read/write scope of the module that owns the item(s) named.
- **Metadata**: `defineTool` gains MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint: false`; defaults from `write`) and an optional `outputSchema` returned as `structuredContent` (W1), adopted by all new tools.
- **Resources**: `nook://<kind>/<id>` templates (`registerMcpResource`, W1) for forms, goals, contacts, deals, check-in rounds, bookings, and existing cards/notes, read through the same adapters and checks as `get_*`.
- **Prompts**: `weekly_goal_review`, `standup_summary`, `pipeline_review`, `timesheet_fill` (suggest entries from calendar events and card activity), registered like `registerRoutinePrompts`.
- **REST v1** exposes every new tool automatically, as today.
- **Chat agents** (`nookBridge`): reads allowed; writes as proposals for registered kinds or directly where the agent's mode allows (D353/D359). Never: creating public links, cancelling bookings, bulk deletes, sharing changes, submitting public responses.

### B.16 Units: durations, money, dates

- `shared/duration.ts` (W1): parse `1h30`, `1h 30m`, `1.5h`, `90m`, `1:30`, `45` (minutes; a preference can make bare numbers hours) → seconds; format `1h 30m` or `1:30` (preference); rounding (6/15/30 min, up or nearest).
- `shared/money.ts` (W1): integer minor units + ISO 4217 code, `Intl.NumberFormat`, no conversion. Workspace default currency `team_settings.default_currency` (085), admins edit it in Settings → Workspace.
- Dates: local `yyyy-mm-dd`, instants UTC ISO, IANA zones, `shared/calendarRecurrence.ts` zoned helpers. A `week_start` user preference (W1, default Monday) drives timesheets, check-in schedules, and Insights weeks.

---

## C. Cross-module integration matrix

Rows are flows a person can do end to end. "Lane" is who builds it; **W2** flows are inside one module lane (using foundations only), **W3** flows need two finished modules and belong to W3-WIRE.

| # | Flow | What happens | Primitives | Lane |
| --- | --- | --- | --- | --- |
| C1 | **Booking → contact + event + card** | A public booking creates the event in the host's calendar (booker as attendee text, answers in the description, link back to the booking), upserts the booker as a contact in the type's book, logs a `meeting` interaction, optionally creates a prep card on a chosen board/column ("Prepare: Intro call with Ana Silva"), links all four, notifies the host, emails the booker ICS + manage link. | B.3 upsert, B.4 links, B.6 reminders, B.7 external mail | BOOK (contact upsert + event + card use foundation and existing services; no CRM lane code needed) |
| C2 | **Form response → card (intake)** | A form action "Create a card" maps answers to title/description/due/assignee/tags/estimate (template with `{{question}}` tokens), puts it on a board/column, links response ↔ card (`source`), attaches uploaded files. | B.2, B.4 | FORMS |
| C3 | **Form response → contact / deal** | Action "Add to CRM": upsert contact by the `contact_email` role answer into a book; optional "Create deal" in a pipeline/stage with value from a number answer; interaction `form` logged. | B.3 | FORMS (contact via foundation), deal part W3 (needs CRM deals) |
| C4 | **Check-in blockers → cards** | A blockers answer referencing `MYT-12` (or picked) links the answer to the card (`blocks`), sets the card's flag "Blocked" with activity "flagged as blocked in *Daily standup*"; clearing next round offers "Unblock MYT-12". | B.4, card flags | CHECKINS |
| C5 | **Check-in → goal updates** | A `goal_update` question shows the participant's KRs; values typed there write goal check-ins (as the participant). | B.2 roles | W3 (needs GOALS) |
| C6 | **Check-in prefill from work** | "What did you do" suggests cards you moved to done, commented on, or logged time on since your last answer; "Plan" suggests cards due/starting today. | card_activity, time entries | CHECKINS (cards), W3 adds time |
| C7 | **KR auto-progress from tasks** | KR source `tasks`: done/total cards (or points) of a board, saved view, tag, epic, or sprint, recomputed on card changes (debounced) and hourly. | progress sources | GOALS |
| C8 | **KR from time logged** | KR source `time`: hours on a time project / card set / tag in the KR's period. | progress sources | TIME registers the source (own file) |
| C9 | **KR from CRM** | KR sources `crm_won_value`, `crm_won_count`, `crm_pipeline_value` for a pipeline in the period. | progress sources | CRM registers the source |
| C10 | **KR from forms / check-ins** | `form_metric` (responses count, average of a rating/scale/number question, NPS) and `checkin_metric` (average of a rating question, participation rate). | progress sources | FORMS and CHECKINS register |
| C11 | **KR from child goals** | Weighted average of children's progress. | — | GOALS |
| C12 | **Time from card timer** | ▶ on a card starts the timer linked to the card (`tracks`), project from the board's linked project; card Time section and face show totals; card activity "logged 1h 30m". | B.4, card_activity kind `time_logged` (new row in shared/cardActivity.ts, W1) | TIME |
| C13 | **Time from calendar** | Day view shows events beside entries; "Log this event" creates an entry with the event's time and title, linked to the event. | event service | TIME |
| C14 | **Time on Timeline and estimates** | Board Timeline bars show a logged-vs-estimate fill for hours boards; card dialog shows "3h 20m of 5h". | estimates (D750) | TIME (adds to Tasks via a registered card-section slot, §F.3) |
| C15 | **Time for contacts/deals/bookings** | Timer and entries can track a contact, company, deal, or booking; client = company (billable reports per client). | B.3, B.4 | TIME (generic work refs), W3 adds CRM record panels |
| C16 | **Deals as a board** | Deal board uses the shared `<KanbanBoard>` (same visual language and pointer drag as Tasks boards: column headers with totals, WIP-style stage limits off), card faces with value, contact chip, next step date, rotting dot. | W1-UI kanban | CRM |
| C17 | **Deals ↔ tasks** | "Create task" on a deal/contact makes a linked card; the card shows the deal chip; finishing it logs an interaction "Task done". | B.4 | CRM |
| C18 | **Polls embedded** | `/poll` in a note or card description creates a poll and inserts an embed; readers vote inline; a card comment can contain a poll too. Agent chat: an agent can create a poll via MCP and post its link. | B.4.4 embeds | FORMS (embed renderer) + W1-UI (editor slash hook) |
| C19 | **Time poll → event** | Finalizing a time poll creates a calendar event in the organizer's chosen calendar with the chosen slot, invitees as workspace attendees (reminders) and emailed guests (ICS). | calendar service, B.7 | FORMS |
| C20 | **Booking ↔ CRM record** | Contact/company/deal pages list bookings; "Send booking link" copies a link prefilled with the contact's name/email (hidden fields). | B.4 | W3 |
| C21 | **Form respondents → contacts** | Public form responses with an email can be saved to a book (C3) and appear on the contact timeline. | B.3 | FORMS + W3 timeline |
| C22 | **Goals on cards/boards** | Card and board "Contributes to goal" field; goal page lists linked work with status; board header chip shows its goal. | B.4 | GOALS (goal side, link picker), W3 (card dialog field) |
| C23 | **Standup digest → note** | Closing a round can append it to a chosen note (published version) and post a summary notification. | notes service | W3 |
| C24 | **AI agents across modules** | One key with `time:write goals:write crm:write checkins:write` can: log time from a summary, check in on goals, update a deal after a call, answer standup, create a poll; agents work through proposals unless allowed. | B.15 | each lane + W3 eval script |
| C25 | **Reports on workspace data** | "This workspace" data source: time by client, pipeline by stage, NPS over time, goal progress, standup participation, bookings per week. | B.10 | W3-REPORTS |
| C26 | **Today & digest** | All §B.11 sections, quick actions, digest sections. | B.11, B.7 | each lane |
| C27 | **Global search** | All scope finds a contact, a goal, a form, a booking, a time entry from one box. | B.12 | each lane |

---

## D. Per-module specifications

Common to every module unless stated: tables carry `created_at`, `updated_at` (ISO UTC); containers and Bin-able records carry `deleted_at`, `deleted_by`, `purge_after` (the `${BIN}` columns of 012/013) and `revision INTEGER NOT NULL DEFAULT 1`; `short_id` is `TEXT NOT NULL UNIQUE CHECK (length(short_id) BETWEEN 6 AND 12)` per friendly URLs (D770–D789). Names ≤ 120, titles ≤ 200, descriptions ≤ 20 000 bytes unless stated. HTTP is JSON under `/api`, errors `{ error, code }` as everywhere (`NOT_FOUND` for unreadable, never 403 for existence, T90 pattern). `:id` path params accept the UUID or the short id.

### D.0 Foundation (W1-CORE, W1-UI)

**Decisions D800–D829 (core), D830–D839 (UI)**, threats **T500–T514**. Key decisions:

- **D800** Pre-register all module words and scopes (§B.1); modules stay hidden (`planned`) until their lane sets `ready`.
- **D801** Registries over shared edits (§B.1); `server/workspaceModules.ts` and `src/workspaceModules/index.ts` are the only import points.
- **D802** One question engine with versioned sets and normalized answers (§B.2).
- **D803** Generic `item_members` / `item_group_grants` for the six new access kinds (§B.9).
- **D804** `work_links` for new links; existing link tables stay and are read by the resolver (§B.4).
- **D805** `item_activity` and `item_comments` generalize card activity and comments for new modules; cards unchanged (§B.5).
- **D806** Upsert-by-email fills empty fields only; never overwrites human edits (§B.3).
- **D807** Contact tables are foundation; each user has a hidden system book "Clients" created lazily for Time when CRM is off (§B.3).
- **D808** One schedules engine with at-most-once fires (§B.6).
- **D809** `notify()` for module notifications; module email categories (§B.7).
- **D810** Public pages under `/p/`, tokens hashed, policies off by default, in-house anti-abuse (§B.8).
- **D811** Datasets with structured queries only, viewer predicate always applied (§B.10).
- **D812** URLs follow friendly URLs (D770–D789) (§B.4.4).
- **D813** Fine-grained deletes are immediate with undo tickets; containers use the Bin (§B.13).
- **D814** MCP tool annotations, output schemas, resources, consistent CRUD/bulk shapes (§B.15).
- **D830** Shared UI components (§E.3) live in `src/ui/` and are the only implementation of each pattern.
- **D831** Public pages render light (§E.6); the app stays dark.

**Migrations:**

| Id | Name | Contents |
| --- | --- | --- |
| **085** | `workspace_words` | 12-step rebuilds (the 039 `api_key_grants` pattern) of `api_key_grants` (modules `forms,time,goals,checkins,crm,bookings`; resource kinds `form,time_project,goal,checkin,contact_book,booking_type`), `proposals` (kinds `time_log,goal_checkin,contact_create,contact_update,deal_create,deal_update,interaction_log,checkin_answer,form_create`; target types `form,time_project,time_entry,goal,key_result,checkin,checkin_round,contact_book,contact,company,deal`), `notifications` (kind `module` + new columns §B.7; index `(user_id, dedupe_key) WHERE read_at IS NULL AND dedupe_key IS NOT NULL` unique), `team_settings` (keys `public_forms`, `public_booking_pages`, `default_currency`); creates `item_members`, `item_group_grants` (+ indexes `(user_id, item_kind)`, `(group_id)`, `(item_kind, item_id)`); recreates `access_grants_v` with both unioned in; adds `grant cleanup` triggers for user/group deletion. |
| **086** | `work_links` | `work_links`, `item_activity` (index `(item_kind, item_id, created_at, id)`), `item_comments` (index `(item_kind, item_id, created_at)`), purge triggers on existing tables (cards, notes, documents, events, collection_rows, boards, calendars, collections, whiteboards, reports) deleting their `work_links` rows; `card_activity` needs no change (kind is free text; `time_logged`, `goal_linked`, `blocked_by_checkin` are new rows in shared/cardActivity.ts). |
| **087** | `questions` | `question_sets(id, host_kind CHECK IN ('form','checkin','booking_type'), host_id, version INTEGER, status CHECK IN ('draft','published'), set_json CHECK json_valid AND ≤ 262144 bytes, created_by, created_at, UNIQUE(host_kind, host_id, version))`, partial unique index one draft per host; `responses(id, host_kind, host_id, set_version, subject_kind NULL, subject_id NULL, respondent_kind CHECK IN ('user','contact','guest','anonymous'), respondent_user_id NULL REFERENCES users ON DELETE SET NULL, respondent_contact_id NULL, respondent_name ≤ 120 NULL, respondent_email ≤ 254 NULL, dedupe_hash NULL CHECK length = 64, status CHECK IN ('submitted','pending_verification'), score REAL NULL, meta_json ≤ 4096, submitted_at, updated_at, revision)`, indexes `(host_kind, host_id, submitted_at DESC, id)`, `(respondent_user_id, host_kind)`, unique `(host_kind, host_id, respondent_user_id) WHERE …one-per-person…` is enforced in service (forms vary); `response_answers(response_id REFERENCES responses ON DELETE CASCADE, question_id, ord INTEGER, option_id NULL, value_text NULL ≤ 10000, value_num NULL, value_json NULL ≤ 16384, PRIMARY KEY (response_id, question_id, ord))`, index `(question_id, option_id)`. |
| **088** | `people` | `contact_books(id, short_id, owner_id, name, color, system_kind NULL CHECK IN ('clients'), visibility, share_role, settings_json ≤ 8192 (link companies by domain, lifecycle options, rotting days), fields_json ≤ 65536 (custom fields, Collections field engine), BIN, revision)`; `companies(id, short_id, book_id REFERENCES contact_books ON DELETE CASCADE, name, domain NULL lower-case ≤ 253, website NULL, description, owner_id NULL, custom_json ≤ 16384, tags_json ≤ 2048, source CHECK IN ('manual','import','booking','form','mcp','email_domain'), last_interaction_at NULL, BIN, revision)` unique `(book_id, domain) WHERE domain IS NOT NULL AND deleted_at IS NULL`; `contacts(id, short_id, book_id, first_name ≤ 80, last_name ≤ 80, display_name ≤ 160 NOT NULL, company_id NULL REFERENCES companies ON DELETE SET NULL, job_title ≤ 120, owner_id NULL, lifecycle ≤ 40 NULL, tz NULL, location ≤ 200, avatar_document_id NULL, custom_json, tags_json, source, source_ref ≤ 80, last_interaction_at, BIN, revision)`, indexes `(book_id, display_name)`, `(company_id)`; `contact_channels(id, book_id, contact_id REFERENCES contacts ON DELETE CASCADE, kind CHECK IN ('email','phone','url','social'), value ≤ 254, value_norm ≤ 254, label ≤ 40, is_primary, position)` unique `(book_id, value_norm) WHERE kind = 'email'`; triggers keep `work_links`/`item_members` clean on purge. |
| **089** | `schedules_public` | `schedules`, `schedule_fires` (§B.6; index `(next_fire_at) WHERE enabled = 1 AND claimed_at IS NULL`, `(owner_kind, owner_id, purpose)`); `public_links` (§B.8; index `(kind, item_id) WHERE revoked_at IS NULL`); `public_submissions_log(id, link_id NULL, kind, item_id, ip_hash CHECK length = 64, email_hash NULL, outcome CHECK IN ('accepted','rate_limited','honeypot','too_fast','replay','invalid','verification_sent'), created_at)` index `(created_at)`; `public_verifications(id, kind, item_id, email_hash, code_hash, payload_json ≤ 65536, attempts, expires_at, created_at)`; `user_preferences` gains nothing (week start, duration format go into the existing prefs JSON — check its 512-byte cap; if exceeded use a new `user_ui_prefs` row). |

**Files W1-CORE creates** (exclusive): `server/workspaceModules.ts`, `server/{forms,time,goals,checkins,crm,bookings}/index.ts` (stubs only), `server/migrations/workspace/*` (+ `085_…`–`089_…`), `server/mcpRegistry.ts`, `server/mcpWorkTools.ts`, `server/searchRegistry.ts`, `server/questions/*`, `server/people/*`, `server/links/*` (`service.ts`, `resolver.ts`, `adapters.ts` for existing kinds, `routes.ts`), `server/activity/*` (item activity + comments + routes), `server/schedules/*`, `server/notify/*`, `server/public/*` (middleware, limits, nonce, verification, links service), `server/datasets/*` (+ `tasks.cards` datasets), `server/undo.ts`, `server/goalsProgress.ts` (progress-source registry), `shared/tones.ts`, `shared/questions/*`, `shared/people.ts`, `shared/workRefs.ts`, `shared/embeds.ts`, `shared/itemActivity.ts`, `shared/datasets.ts`, `shared/duration.ts`, `shared/money.ts`, `shared/freeMailDomains.ts`, `shared/shortIds.ts` (only if the friendly-URL helper is absent). Edits (W1 only): `server/index.ts`, `server/mcpTools.ts`, `server/mcpScopes.ts`, `server/keyGrants.ts`, `server/keyResources.ts`, `server/moduleIds.ts`, `server/team/roles.ts`, `server/team/policies.ts`, `server/access/{levels,shares,effective,itemAccess}.ts`, `server/bin.ts`, `server/searchRoutes.ts`, `server/mail/{registry,digest,outbox}.ts`, `server/calendar/reminders.ts` (notification listing of `module` rows), `server/inbox/kinds.ts`, `server/agents/nookBridge.ts`, `server/mcpToolKit.ts`, `server/sweeper.ts` (schedules + public log retention), `shared/cardActivity.ts` (+ `time_logged`, `goal_linked`, `goal_unlinked`, `blocked_by_checkin` kinds and renderers), `server/migrations/index.ts`.

**Files W1-UI creates** (exclusive): `src/workspaceModules/*`, `src/{forms,time,goals,checkins,crm,bookings}/module.tsx` (stubs), `src/public/*` (`PublicApp`, `PublicPageShell`, `public.css`), `src/ui/questions/*`, `src/ui/people/*` (`PersonChip`, `PersonPicker`, `CompanyChip`), `src/ui/links/*` (`WorkRefChip`, `LinkedItemsPanel`, `LinkPicker`), `src/ui/activity/ItemTimeline.tsx`, `src/ui/kanban/*` (`KanbanBoard`, pointer drag ported from Tasks' approach with `scripts/dragSmoke.ts` coverage), `src/ui/progress/*` (`ProgressBar`, `ProgressRing`, `HealthChip`), `src/ui/time/*` (`DurationInput`, `DurationChip`, `TimerChip` shell), `src/ui/schedule/SchedulePicker.tsx`, `src/ui/money/MoneyInput.tsx`, `src/ui/insights/*` (`InsightChart`, `KpiTile` wrappers), `src/ui/ModuleHome.tsx` (module home scaffold §E.2), `src/ui/EmptyState.tsx` (if absent), `src/ui/cardSlots.ts` (registries for card dialog sections, card face badges, card header actions). Edits (W1-UI only): `src/modules.ts`, `src/router.ts`, `src/App.tsx`, `src/appShellNavigation.ts`, `src/main.tsx`, `src/AppShell.tsx` (top-bar slot for module items like the timer), `src/today/*` (quick actions row, generic module sections), `src/tasks/CardDialog.tsx` + `CardPage.tsx` + `CardFace.tsx` (render `cardSlots` registrations), `src/editor/slash.ts` + `src/editor/extensions.ts` (generic embed node + registered slash items), `src/notifications/*` (module rows), `src/settings/*` (Settings → Notifications module rows, Settings → Workspace currency/week start, Policies toggles).

**HTTP (foundation):**

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/api/links?kind=&id=` | — | `{ links: [{ id, relation, direction, other: WorkSummary \| { kind, hidden: true } }] }` |
| POST | `/api/links` | `{ a: WorkRef, b: WorkRef \| { ref: string }, relation }` | `{ link }` (409 `EXISTS`) |
| DELETE | `/api/links/:linkId` | — | 204 |
| GET | `/api/refs/resolve?ref=` | — | `{ summary: WorkSummary }` or 404 |
| GET | `/api/items/:kind/:id/activity?order=&cursor=` | — | `{ entries, nextCursor }` |
| GET/POST | `/api/items/:kind/:id/comments` | `{ body, parentId? }` | comment list / created |
| PATCH/DELETE | `/api/items/:kind/:id/comments/:cid` | `{ body }` | — |
| GET | `/api/people/search?q=&allow=user,group,contact&book=` | — | `{ people: PersonSummary[] }` |
| GET | `/api/datasets` | — | `{ datasets }` (readable modules only) |
| POST | `/api/datasets/query` | structured query | `{ columns, rows, truncated }` |
| GET | `/api/search?scope=all&q=` | — | `{ sections: [{ scope, results, truncated }] }` |
| POST | `/api/undo/:ticket` | — | restores the captured rows |

**MCP (foundation):** `resolve_ref`, `link_items`, `unlink_items`, `list_links`, `search_workspace`, `list_datasets`, `query_dataset`, `get_item_activity`, `comment_on_item`, `list_item_comments`; resources `nook://card/<key>`, `nook://note/<id>`.

**Threats (foundation):** T500 a registry lets a module's route skip the session/CSRF middleware → `mountWorkspaceModules` mounts under the same app after the guards; public routes only via `publicRoutes` under `/p` and `/api/public`, test enumerates. T501 links leak titles across access → resolver null-redaction, test per kind. T502 dataset query bypasses access → compiled SQL always ANDs `scope(viewer)`, structured input only, fuzz test. T503 contact details leak via chips. T504 schedule handler runs twice → `schedule_fires` PK. T505 audit leaks PII. T506 public endpoint abuse/DoS → §B.8 limits. T507 public token guessing/timing → 32-byte tokens, hash lookup, uniform 404. T508 external mail used to spam arbitrary addresses → per-address and per-item caps, only addresses a booker/guest typed for their own booking/vote, verification option. T509 notification `href` injection → hrefs built server-side from kinds, relative paths only. T510 `access_grants_v` rebuild loses grants → migration test compares counts before/after. T511 generic member table allows cross-kind confusion → every query filters `item_kind`, composite PK. T512 undo ticket replay restores data another user deleted later → tickets bound to actor, 10-minute expiry, revision check. T513 embeds reveal titles → neutral text (§B.4.4). T514 CSV formula injection in exports.

**Tests (foundation):** `tests/workspaceRegistry.test.ts` (stubs mount, hidden while not ready, routes behind auth), `tests/workspaceMigrations.test.ts` (085–089 on a copy of a 082 DB with data: grants/proposals/notifications preserved, CHECKs accept new words, view counts equal), `tests/questions*.test.ts` (every type: validate/aggregate; logic; versions; CSV), `tests/workLinks.test.ts`, `tests/itemActivity.test.ts`, `tests/schedules.test.ts` (clock, DST, crash between claim and finish, lateness), `tests/notify.test.ts`, `tests/publicPages.test.ts` (headers, 404 uniformity, limits, honeypot, too-fast, replay, verification), `tests/datasets.test.ts` (access predicate, buckets, limits), `tests/peopleUpsert.test.ts`, `tests/mcpWorkTools.test.ts`, `tests/duration.test.ts`, `tests/money.test.ts`, client `tests/questionEditor.test.tsx`, `tests/questionRenderer.test.tsx`, `tests/kanban.test.tsx`, `tests/workspaceRoutes.test.tsx`, plus `scripts/dragSmoke.ts` case for `<KanbanBoard>`.

### D.1 Forms & Polls (lane FORMS, module `forms`)

**Decisions D840–D869**, threats **T515–T529**, migrations **090–092**.

Key decisions:
- **D840** One module, three kinds (`form`, `poll`, `time_poll`), one table; a poll is a form with exactly one choice question and poll-specific display.
- **D841** Editing a published form saves a draft set; **Publish changes** creates a new version; responses pin their version (§B.2).
- **D842** Audience (who answers) is separate from access (who sees results/edits) (§B.9).
- **D843** Anonymous forms store no respondent identity at all (no user id, no email, no IP hash beyond the 30-day abuse log); one-per-person on an anonymous form uses a keyed HMAC of the user id that cannot be reversed to the user from the stored row (T518 discusses the residual risk: the server holds the key).
- **D844** Poll results visibility: `live`, `after_vote`, `after_close`, `owner_only`; named votes show voter chips only to those who can see results.
- **D845** Response actions run inside the submission's transaction where local (card, contact), and are retried by a schedule if they fail (action log row with status), never blocking the respondent.
- **D846** Time polls store slots in UTC and render in each viewer's zone; finalizing is owner/editor only.

**Tables:**

```
090 forms
forms(id, short_id, owner_id, kind CHECK IN ('form','poll','time_poll'), title ≤ 200, description_md ≤ 20000,
  status CHECK IN ('draft','open','closed'), audience CHECK IN ('workspace','selected','public'),
  audience_json ≤ 8192 (user/group ids for 'selected'), anonymous 0/1, limit_per CHECK IN ('none','person','browser'),
  allow_edit 0/1, results_visibility CHECK IN ('owner_only','live','after_vote','after_close'),
  display CHECK IN ('page','stepper'), opens_at NULL, closes_at NULL, max_responses NULL CHECK 1..100000,
  verify_email 0/1, theme_json ≤ 2048 (accent from the §E palette, cover document id),
  ending_json ≤ 8192, settings_json ≤ 8192 (notify on response, show progress bar, confirmation copy),
  calendar_id NULL (time_poll target), finalized_slot_id NULL, finalized_event_id NULL,
  response_count INTEGER NOT NULL DEFAULT 0, last_response_at NULL,
  visibility, share_role, BIN, revision, created_at, updated_at, closed_at NULL)
  idx (owner_id, deleted_at), (status, closes_at)
form_actions(id, form_id → forms CASCADE, kind CHECK IN ('create_card','save_contact','create_deal','notify'),
  config_json ≤ 16384, enabled, position, created_by, created_at, updated_at)
form_action_runs(id, action_id → form_actions CASCADE, response_id → responses CASCADE, status CHECK IN ('done','failed','pending'),
  result_ref ≤ 120 NULL, error ≤ 500 NULL, attempts, created_at, updated_at)  idx (status) WHERE status <> 'done'
form_visits(form_id, day, views, starts, submits, PRIMARY KEY(form_id, day))   -- completion funnel, no PII
091 forms_fts  forms_fts(title, body) + triggers; purge triggers (work_links, item_members, item_group_grants, public_links, schedules, question_sets, responses for host_kind='form')
092 (spare)
```

**HTTP:**

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/forms?kind=&status=&owner=me&cursor=` | list readable (results level) + forms you can answer (`canRespond`) |
| POST | `/api/forms` | `{ kind, title, questions?, template? }` → form with draft set |
| GET/PATCH | `/api/forms/:id` | settings; PATCH `{ title?, status?, audience?, … , expectedRevision }` |
| GET/PUT | `/api/forms/:id/draft` | the draft question set |
| POST | `/api/forms/:id/publish` | draft → new version (validates logic) |
| POST | `/api/forms/:id/duplicate` | |
| GET | `/api/forms/:id/respond` | for respondents: current published set + your existing response |
| POST | `/api/forms/:id/responses` | submit (members); PUT `/responses/:rid` to edit when allowed |
| GET | `/api/forms/:id/responses?filter=&cursor=` | result readers |
| GET/DELETE | `/api/forms/:id/responses/:rid` | DELETE → undo ticket |
| GET | `/api/forms/:id/summary?filter=` | per-question aggregates, funnel |
| GET | `/api/forms/:id/export.csv` | |
| GET/POST/PATCH/DELETE | `/api/forms/:id/actions[/:aid]` | response actions |
| POST | `/api/forms/:id/finalize` | time poll: `{ slotId, calendarId, inviteUserIds, emailGuests }` → event |
| POST/DELETE | `/api/forms/:id/public-link` | create/rotate/revoke (policy `public_forms`) |
| GET | `/api/public/forms/:token` | public definition (no internal ids beyond question/option ids) + render nonce |
| POST | `/api/public/forms/:token/responses` | public submit (§B.8 checks) |
| POST | `/api/public/forms/:token/verify` | email code |
| GET | `/api/public/forms/:token/results` | poll/time-poll results when visibility allows |

**MCP** (`forms:read` / `forms:write`): `list_forms`, `get_form` (with questions), `create_form` (`{ kind, title, questions: Question[] }`, validated), `update_form` (settings), `update_form_questions` (replace draft; `publish: true` to publish), `set_form_status`, `list_responses`, `get_response`, `get_form_summary`, `export_responses` (CSV text ≤ 1 MiB), `submit_response` (as the key owner; members-audience forms only), `create_poll` (`{ question, options, multiple?, anonymous?, closesAt?, embedIn?: WorkRef }`), `vote_poll`, `create_time_poll` (`{ title, slots, participants }`), `finalize_time_poll`, `delete_form` (Bin; + `bin:write`). Agents: reads + `create_poll`, `vote_poll`, `submit_response` allowed; `create_form` as proposal `form_create`; never public links.

**UI:**
- **Forms home** (`/forms`): ModuleHome (§E.2) with tabs **My forms**, **Shared with me**, **To answer**; list rows: kind icon, title, status chip, responses count + sparkline, last response, owner chip; New ▾ (Form, Poll, Find a time, From template: Feedback, Event registration, Intake request, NPS, Job application, Quick poll).
- **Form editor** (`/forms/<slug>-<sid>/edit`): left `<QuestionSetEditor>`, right live preview (desktop ≥ 1280); top bar: title, status, **Preview**, **Share** (sheet: audience, public link with QR via `qrcode`, embed snippet for notes), **Publish changes** when the draft differs; Settings sheet (limits, closing, results visibility, display mode, theme, ending, verification); **Actions** tab.
- **Results** (`/forms/<slug>-<sid>/results`): Summary (per-question `<QuestionSummary>`, funnel views→starts→submits, filter bar "where Q is A"), Responses (table with column picker; open one in `<ResponseViewer>`; comments per response via ItemTimeline), Export.
- **Respond** (`/forms/<slug>-<sid>`): in-app renderer, same look as public but dark.
- **Poll**: compact card (question, options with bars, vote button, "N votes · closes in 2h"); embeds render the same card.
- **Time poll**: grid (slots as columns grouped by day, participants as rows; yes ✓ / maybe (✓) / no; best slot highlighted); mobile: list of slots with three-state toggles; finalize sheet.
- **Public page** `/p/f/<token>`: PublicPageShell; stepper or page mode; progress bar; validation inline; ending screen; poll results if allowed.
- Mobile 375: editor becomes single column with a bottom "+ Add question" bar; question settings open as a sheet.

**Notifications:** owner/followers on new responses (coalesced 15 min: "5 new responses to *Onboarding survey*"), poll closed (voters), time poll finalized (participants + guests by email), form closing in 24 h (owner).

**Schedules:** `forms.open` (opens_at), `forms.close` (closes_at), `forms.actions_retry`.

**Reports datasets:** `forms.responses` (form, kind, submitted_at, respondent kind, score), `forms.answers` (form, question, option, value_num, value_text truncated, submitted_at).

**Search:** forms (title, description, question titles); responses are not indexed globally (results readers search inside a form, T519).

**Bin:** `form` (with its responses, sets, actions); purge cascades.

**Audit:** `forms.create`, `forms.update`, `forms.publish`, `forms.status`, `forms.public_link`, `forms.response_submit` (no answers), `forms.response_delete`, `forms.export`, `forms.action_run`, `forms.finalize`.

**Threats:** T515 public submissions spam → §B.8. T516 public file upload abuse → members-only `file` type. T517 response data exposure to people with edit but not results access → results need `view` level on the form (respondents never get it unless `results_visibility` grants aggregate-only views; aggregates exclude text answers). T518 anonymous deanonymization by timing/small n → no timestamps finer than the day on anonymous responses shown to readers, aggregates only below 3 responses for anonymous text answers. T519 search leak of answers. T520 action templates inject Markdown/links into cards → answers are escaped in templates; links are autolinked only for `url` answers. T521 time-poll guest emails used for spam → only participants' own emails, capped (§B.7). T522 poll vote stuffing by members via MCP → one vote per user, MCP rate limits. T523 hidden fields used to impersonate (e.g. `email=ceo@`) → hidden values are labelled as unverified and never used for upsert unless `verify_email`.

**Acceptance (browser):** create a form with 8 types incl. logic and a section jump; publish; answer as another member on a phone at 375 px; change a question and publish v2; old response still renders; summary charts correct; filter; CSV opens in a spreadsheet with no formula execution; public link (policy on) submits from a private window; honeypot and too-fast are refused; action creates a card on a board with mapped fields and a contact in a book; poll created from `/poll` in a note, voted inline by two users, results hidden until vote; time poll with 6 slots across two zones, finalize → event appears in the calendar with reminders.
**Acceptance (MCP):** `create_form` with questions → `get_form` → `submit_response` (second key) → `get_form_summary`; `create_poll` with `embedIn: note` → note shows embed; `finalize_time_poll`; chosen-item key limited to one form cannot list others (NOT_FOUND).
**Tests:** `tests/forms*.test.ts` (service, routes, public, actions, time poll, MCP, bin/purge orphans), `tests/formsClient.test.tsx` (editor, renderer, results, poll card, time-poll grid).

### D.2 Time tracking (lane TIME, module `time`)

**Decisions D870–D899**, threats **T530–T539**, migrations **093–095**.

Key decisions:
- **D870** One running timer per person (partial unique index); starting a new one stops the old at the same instant.
- **D871** Entries store `started_at` + `duration_s` (+ `ended_at` when stopped); running entries have `ended_at NULL` and duration computed live; max entry 24 h (longer is split by the UI on save).
- **D872** Visibility: your own entries always; a project's entries to its `edit`+ members; an entry linked to a card is visible (description, person, duration) to the card's readers (Jira worklog behavior), unless the project is "private time" (`settings.private_entries`), in which case card readers see totals only.
- **D873** Rates and billable amounts are visible to project `manage` and the entry's author only; others see hours.
- **D874** Approval locks weeks per person per project; locked entries are read-only for the author; managers can unlock (audited).
- **D875** Rounding is applied in reports only, never to stored entries.
- **D876** Client = CRM company (§B.3); project ↔ board link sets the default project for cards on that board.

**Tables:**

```
093 time
time_projects(id, short_id, owner_id, name ≤ 120, code ≤ 12 NULL, color, company_id NULL → companies SET NULL,
  board_id NULL → boards SET NULL, billable_default 0/1, rate_minor NULL ≥ 0, currency CHECK length 3,
  budget_kind CHECK IN ('none','hours','money'), budget_value NULL ≥ 0, budget_period CHECK IN ('total','monthly'),
  settings_json ≤ 4096 (private_entries, require_description, require_link), archived_at NULL,
  visibility, share_role, BIN, revision, created_at, updated_at)  unique (board_id) WHERE board_id IS NOT NULL AND deleted_at IS NULL
time_member_rates(project_id → time_projects CASCADE, user_id → users CASCADE, rate_minor, PRIMARY KEY(project_id,user_id))
time_entries(id, user_id → users CASCADE, project_id NULL → time_projects SET NULL, description ≤ 500,
  started_at NOT NULL, ended_at NULL, duration_s NULL CHECK 0..86400, tz,
  billable 0/1, rate_minor NULL, currency NULL, tags_json ≤ 512,
  target_kind NULL, target_id NULL (primary work ref: card/goal/contact/company/deal/booking/event),
  source CHECK IN ('timer','manual','calendar','import','mcp','proposal'), locked_at NULL, locked_by NULL,
  revision, created_at, updated_at,
  CHECK ((ended_at IS NULL) = (duration_s IS NULL)))
  unique (user_id) WHERE ended_at IS NULL           -- one running timer
  idx (user_id, started_at DESC), (project_id, started_at), (target_kind, target_id, started_at)
time_tags(owner_scope='workspace', name ≤ 40 UNIQUE COLLATE NOCASE, color, created_at)
time_approvals(id, project_id → time_projects CASCADE, user_id, week_start DATE, status CHECK IN ('submitted','approved','rejected'),
  note ≤ 500, decided_by NULL, decided_at NULL, created_at, UNIQUE(project_id,user_id,week_start))
094 time_fts + purge triggers (work_links for time_entry/time_project, item_members, schedules) + card purge trigger clearing target refs
095 (spare)
```

**HTTP:**

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/time/timer` | running entry or null |
| POST | `/api/time/timer/start` | `{ description?, projectId?, target?: WorkRef, billable?, tags? }` → stops previous |
| POST | `/api/time/timer/stop` | `{ at? }` |
| GET | `/api/time/entries?from=&to=&user=me\|id&project=&target=&cursor=` | |
| POST | `/api/time/entries` | `{ startedAt, duration \| endedAt, … }` (duration string accepted) |
| PATCH/DELETE | `/api/time/entries/:id` | DELETE → undo ticket |
| POST | `/api/time/entries/bulk` | `{ op: "create"\|"update"\|"delete", items, dryRun? }` |
| GET | `/api/time/timesheet?week=` | grid rows/cells for the user |
| PUT | `/api/time/timesheet/cell` | `{ week, row: { projectId, target? }, day, duration }` (creates/adjusts one entry per cell) |
| GET | `/api/time/summary?from=&to=&groupBy=project,user,target,tag,day&filters…&rounding=` | |
| GET | `/api/time/export.csv?…` | |
| CRUD | `/api/time/projects[/:id]` | + `/rates`, `/budget` |
| POST | `/api/time/approvals` | submit week; PATCH `/:id` approve/reject; POST `/unlock` |
| GET | `/api/time/targets/:kind/:id` | totals + entries for a card/goal/contact/… (card Time section) |
| GET | `/api/time/suggestions?date=` | calendar events and card activity of the day not yet logged |

**MCP** (`time:read` / `time:write`): `get_running_timer`, `start_timer`, `stop_timer`, `log_time` (`{ duration | start/end, description, project, target (key/URL ok), billable?, tags? }`), `list_time_entries`, `update_time_entry`, `delete_time_entry`, `bulk_log_time` (dryRun), `time_summary` (`groupBy`, range, filters → rows with seconds and amount when allowed), `list_time_projects`, `create_time_project`, `update_time_project`, `get_time_for_item` (card/goal/contact), `suggest_time_entries` (from calendar and activity; read-only). Agents: reads; `log_time` as proposal `time_log` (or direct when allowed); never approvals.

**UI:**
- **Timer chip** in the top bar (AppShell slot, W1-UI): idle "▶ Start timer"; running "● 1:23:45 · MYT-12 Fix login" with stop; click opens a popover (description, project, work item `LinkPicker`, billable, tags, start time edit, recent entries to continue). Keyboard: `⌥T` start/stop globally. Mobile: chip collapses to a dot + time in the header, tap opens a bottom sheet.
- **Time home** (`/time`): tabs **Timer** (today list grouped by day, Toggl-like rows, inline edit, continue ▶, totals per day/week), **Timesheet** (week grid; type `1:30` in cells; row add picker; week totals; submit for approval), **Calendar** (day/week; entries as blocks; calendar events as ghost blocks with "Log"; drag to create/resize; uses `src/ui/calendarGrid`), **Reports** (Insights: summary with group-by chips, bar by day, donut by project, table, rounding, billable toggle, CSV), **Projects** (list with budget progress bars; project page: members & rates, budget, linked board, client, entries).
- **Card dialog Time section** (registered card slot): "▶ Start" button, logged total vs estimate ("3h 20m of 5h", ProgressBar), worklog list (person, date, duration, description), "Log time" inline (`DurationInput`). Card face badge "⏱ 3h 20m" (board setting "Show time on cards").
- **Timeline** (board): logged-vs-estimate fill on bars for hours boards (registered timeline decoration hook in W1-UI's card slots).
- Mobile 375: Timer tab first; timesheet becomes a day-by-day list with a week strip on top ("two rows, nothing hidden").

**Notifications:** timer running > 8 h (author, once), weekly "submit your timesheet" (opt-in per project), approval decided, budget at 80/100% (project managers).
**Schedules:** `time.long_timer` (per running entry), `time.budget_check` (daily), `time.timesheet_reminder` (weekly, opt-in).
**Datasets:** `time.entries` (user, project, client, target kind/id/key, date, seconds, billable, amount_minor (only for allowed viewers; null otherwise), tags).
**Progress source (Goals):** `time` — seconds in the KR period over a project / board's cards / tag / user set, as hours.
**Search:** entry descriptions (own and visible), projects.
**Bin:** `time_project` (entries keep `project_id` until purge, then SET NULL; T533 discussion: purge keeps entries as personal).
**Audit:** `time.entry_create|update|delete`, `time.timer_start|stop`, `time.project_*`, `time.rate_change`, `time.approval_*`, `time.export`.
**Threats:** T530 rate/amount leakage → D873 server-side redaction, dataset column nulled. T531 chosen-item keys and project-less entries → whole-module only. T532 editing others' entries → only `manage` on the entry's project; never across projects. T533 locked-week bypass via MCP/bulk → service-level lock check. T534 timer state race across devices → unique index + transaction; client re-fetches on focus. T535 card readers learning private project time → D872 setting.

**Acceptance (browser):** start the timer from a card (`MYT-12`), reload, switch device (second browser), stop; entry shows on the card and the Timer tab; manual `1h30` entry; timesheet cell edit; calendar "Log this event"; project with client (company) and rate; billable summary by client with 15-min rounding; CSV; budget bar; approval locks the week; hours-estimate board shows logged-vs-estimate on the card and Timeline; 375 px header chip and timesheet day list.
**Acceptance (MCP):** `start_timer` with `target: "MYT-12"` → `get_running_timer` → `stop_timer` → `time_summary groupBy=target`; `bulk_log_time dryRun` then real; agent proposal `time_log` approved in Inbox.
**Tests:** `tests/time*.test.ts` (timer uniqueness and race, duration parse, visibility D872/D873, approvals, summary math with rounding and zones/DST weeks, CSV, MCP, purge), `tests/timeClient.test.tsx` (chip, popover, timesheet keyboard, card section).

### D.3 Goals / OKRs (lane GOALS, module `goals`)

**Decisions D900–D929**, threats **T540–T549**, migrations **096–098**.

Key decisions:
- **D900** Goal → key results; goals nest via `parent_id` (alignment), no access inheritance (each goal has its own access, as D15 for folders); the roll-up is computed once server-side over all children (true progress, the same number for every viewer); a child the viewer cannot open appears as "A goal you can't open" with its progress only (T541 accepts that progress leak; open question Q4).
- **D901** Progress 0–1 per KR: `(current − start) / (target − start)` clamped (decrease KRs invert; `stay_above/below` are 1 when within bound else 0; boolean 0/1; milestones = done/total). Goal progress = weighted mean of KRs, or of children when it has no KRs.
- **D902** Health is set by the owner at check-in (`on_track`, `at_risk`, `off_track`); a suggested health is computed from progress vs elapsed time (shown, not stored).
- **D903** Auto sources recompute on change events (debounced 60 s per KR, via a schedule `goals.recompute`) and hourly; each recompute that changes the value writes a `kr_values` point (at most one per KR per hour; daily compaction keeps the last per day after 30 days).
- **D904** Periods are workspace-wide (admins and members create); goals may also have custom dates.
- **D905** Closing a goal snapshots final progress and state (`achieved`, `missed`, `dropped`, `carried_over` → a copy in the next period linked by `source`).
- **D906** Progress sources are a registry (`registerProgressSource(kind, { label, configSchema, compute(config, period, viewerless) })`); compute runs as the KR owner's access (T540): sources only count items the KR owner can read.

**Tables:**

```
096 goals
goal_periods(id, name ≤ 60, starts_on DATE, ends_on DATE, created_by, created_at, archived_at NULL, CHECK (ends_on > starts_on))
goals(id, short_id, owner_id, parent_id NULL → goals SET NULL, period_id NULL → goal_periods SET NULL,
  title ≤ 200, description_md ≤ 20000, kind CHECK IN ('objective','kpi'), group_id NULL → user_groups SET NULL (team),
  start_on NULL, due_on NULL, state CHECK IN ('draft','active','achieved','missed','dropped','carried_over'),
  health CHECK IN ('none','on_track','at_risk','off_track') DEFAULT 'none', progress REAL CHECK 0..1,
  progress_mode CHECK IN ('key_results','children','manual'), checkin_cadence CHECK IN ('none','weekly','biweekly','monthly'),
  last_checkin_at NULL, closed_at NULL, final_progress NULL, position REAL, color,
  visibility DEFAULT 'all_users', share_role DEFAULT 'viewer', BIN, revision, created_at, updated_at)
  idx (period_id, parent_id), (owner_id), (group_id)
key_results(id, goal_id → goals CASCADE, title ≤ 200, owner_id NULL, metric CHECK IN ('number','percent','currency','boolean','milestones'),
  direction CHECK IN ('increase','decrease','stay_above','stay_below'), start_value REAL, target_value REAL, current_value REAL,
  unit ≤ 16, currency NULL, weight REAL DEFAULT 1 CHECK > 0, source_kind ≤ 32 DEFAULT 'manual', source_json ≤ 8192,
  source_error ≤ 300 NULL, auto_updated_at NULL, progress REAL, position REAL, revision, created_at, updated_at)
kr_milestones(id, kr_id → key_results CASCADE, title ≤ 200, done_at NULL, position)
kr_values(kr_id → key_results CASCADE, at, value REAL, progress REAL, source CHECK IN ('checkin','auto','edit'), PRIMARY KEY(kr_id, at))
goal_checkins(id, goal_id → goals CASCADE, author_id, health, confidence INTEGER NULL CHECK 1..10, note_md ≤ 10000,
  values_json ≤ 8192 ({krId: value}), via, created_at)  idx (goal_id, created_at DESC)
097 goals_fts + purge triggers (work_links, item_members, item_group_grants, item_activity, item_comments, schedules)
098 (spare)
```

**Progress sources** (v1): `manual`; `tasks` (`{ scope: board | view | tag | epic | sprint, id, measure: "cards" | "points" | "hours_estimate", doneMeans: "done_columns" }`); `goal_children`; registered by other lanes in their own folders: `time` (TIME), `crm_won_value`, `crm_won_count`, `crm_pipeline_value` (CRM), `form_responses`, `form_average`, `form_nps` (FORMS), `checkin_average`, `checkin_participation` (CHECKINS).

**HTTP:**

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/goals?period=&owner=&group=&parent=&state=&view=tree\|list&cursor=` | |
| POST | `/api/goals` | `{ title, parentId?, periodId?, keyResults? }` |
| GET/PATCH/DELETE | `/api/goals/:id` | |
| POST | `/api/goals/:id/key-results`; PATCH/DELETE `/api/key-results/:id` | KR CRUD, `source` config validated by its source |
| POST | `/api/key-results/:id/preview-source` | compute without saving (editor preview) |
| POST | `/api/goals/:id/checkins` | `{ health, confidence?, note?, values: {krId: value} }` |
| GET | `/api/goals/:id/checkins?cursor=` · `/api/key-results/:id/values?from=&to=` | history chart |
| POST | `/api/goals/:id/close` | `{ state, carryOver?: { periodId } }` |
| CRUD | `/api/goal-periods` | |
| GET | `/api/goals/:id/work` | linked work with status (resolver) |

**MCP** (`goals:read` / `goals:write`): `list_goals` (filters, tree flag), `get_goal` (KRs, children summary, linked work, last check-in), `create_goal`, `update_goal`, `add_key_result`, `update_key_result` (incl. source), `delete_key_result`, `check_in_goal` (`{ goal, health, confidence?, note?, values }`), `list_goal_checkins`, `close_goal`, `list_goal_periods`, `create_goal_period`, `delete_goal` (Bin). Linking work via `link_items` (relation `contributes`). Agents: reads; `check_in_goal` as proposal `goal_checkin`; prompt `weekly_goal_review`.

**UI:**
- **Goals home** (`/goals`): period switcher (current period default), view switch **Tree** | **List** | **Timeline** | **Mine**, filters (owner, team, health, state). Rows: health dot, title, owner chip, team chip, `ProgressBar` with %, KR count, last check-in age ("3 days ago", red when overdue). Tree: indented with expand/collapse, roll-up shown.
- **Goal page** (`/goals/<slug>-<sid>`): header (title, health chip, period/dates, owner, team, ProgressRing), KRs list (each: title, `start → current → target` with unit, progress bar, source badge "Auto · Tasks: Roadmap done cards", edit inline for manual), **Check in** button (sheet: per-KR value inputs prefilled, health segmented control, confidence slider, note), **Progress** chart (line of kr_values and goal progress vs ideal line), **Work** (linked cards/boards/deals/forms with status; "Link work" picker), **Children**, **Timeline** (ItemTimeline: check-ins, changes, comments).
- **Card dialog** "Goal" field (W3 slot) and board header goal chip.
- Mobile 375: list view default; KR rows stack value over bar; check-in sheet full-screen.

**Notifications:** check-in due (owner, by cadence), goal health changed to at risk/off track (followers: members with comment+ and parent owner), KR auto-source failing (owner), period ending in 7 days (owners of open goals).
**Schedules:** `goals.checkin_reminder` (per goal cadence), `goals.recompute` (debounced per KR, plus hourly sweep), `goals.period_end`.
**Datasets:** `goals.key_results` (goal, period, owner, team, progress, current, target, health), `goals.kr_values` (time series), `goals.checkins` (goal, author, health, confidence, at).
**Search:** goals and KR titles.
**Bin:** `goal` (with KRs, check-ins); children are detached (parent SET NULL) only on purge.
**Audit:** `goals.create|update|delete|close`, `goals.kr_*`, `goals.checkin`, `goals.period_*`.
**Threats:** T540 auto source counts items the viewer can't read → sources run as the KR owner and expose only a number and the source's description; source config naming a board the owner can't read is refused. T541 roll-up leaks hidden child progress (accepted, Q4). T542 check-in spoofing via MCP for goals you can't edit → edit level required. T543 recompute DoS (huge boards) → bounded COUNT queries with indexes, debounce, 2 s budget per KR, `source_error` on timeout.

**Acceptance (browser):** create period Q1, company goal with two KRs (manual number, tasks-auto on a board's done cards), child team goal; move a card to done → KR progress updates within ~1 min; check in with health and note; chart shows points; link a card (card shows the goal chip via W3; in W2 the goal page lists the card); close period with carry-over; tree and list at 375 px.
**Acceptance (MCP):** `create_goal` with KRs → `link_items(card→goal, contributes)` → card done → `get_goal` shows new progress → `check_in_goal`.
**Tests:** `tests/goals*.test.ts` (progress math all metrics/directions, roll-up, sources tasks/children, recompute debounce and budget, access of sources, check-ins, close/carry-over, MCP, purge), `tests/goalsClient.test.tsx`.

### D.4 Check-ins / standups (lane CHECKINS, module `checkins`)

**Decisions D930–D959**, threats **T550–T559**, migrations **099–101**.

Key decisions:
- **D930** A check-in is a container (access kind `checkin`) with a question set (§B.2), a schedule, participants, and rounds; each round is one date in the check-in's cadence.
- **D931** Rounds open per participant at their local time (`participant` zone mode) or at one fixed time (`fixed`); a round's date is the cadence date, so a participant in Tokyo and one in Lisbon answer the same "Tue 14 Jan" round.
- **D932** Participation states: `pending`, `answered`, `late` (after deadline), `skipped` (participant chose), `out` (paused/OOO). Streak = consecutive scheduled rounds answered (out rounds don't break it).
- **D933** Answers are editable until the round closes (+ 24 h); edits keep history in item_activity.
- **D934** Anonymous (pulse) check-ins store responses as `anonymous` with no user link; per-person participation is tracked separately in `checkin_round_participants` (who answered, not what) and results show only when ≥ 3 answered (T553).
- **D935** Blockers: answers to a `blockers` question are scanned for work refs on save; each ref creates a `blocks` link and sets the card flag "Blocked" (with card activity) if the author can edit the card; otherwise only the link is recorded.
- **D936** Prefill suggestions are computed on open from the participant's own card activity, time entries (W3), and calendar; nothing is posted without the participant's confirmation.

**Tables:**

```
099 checkins
checkins(id, short_id, owner_id, name ≤ 120, template CHECK IN ('standup','weekly','retro','pulse','custom'),
  description_md ≤ 4000, anonymous 0/1, status CHECK IN ('active','paused'),
  schedule_json ≤ 2048 ({ weekdays: [1..5], time: "09:30", zoneMode: "participant"|"fixed", tz, everyNWeeks }),
  deadline_minutes INTEGER CHECK 30..10080, reminder_minutes_before INTEGER NULL,
  summary_json ≤ 4096 ({ notifyFollowers, email, noteId? }), audience CHECK IN ('participants'),
  visibility DEFAULT 'selected', share_role DEFAULT 'viewer', BIN, revision, created_at, updated_at)
checkin_participants(checkin_id → checkins CASCADE, user_id → users CASCADE, tz NULL, paused_until DATE NULL,
  joined_at, via_group_id NULL, PRIMARY KEY(checkin_id, user_id))
checkin_rounds(id, checkin_id → checkins CASCADE, round_date DATE, opens_at, closes_at, status CHECK IN ('scheduled','open','closed'),
  answered_count, participant_count, summary_md ≤ 20000 NULL, created_at, UNIQUE(checkin_id, round_date))
checkin_round_participants(round_id → checkin_rounds CASCADE, user_id → users CASCADE, status CHECK IN ('pending','answered','late','skipped','out'),
  opens_at, reminded_at NULL, answered_at NULL, response_id NULL (NULL for anonymous), PRIMARY KEY(round_id, user_id))
  idx (user_id, status)
100 checkins_fts (answers text for readers) + purge triggers (responses host 'checkin', work_links, item_members, item_group_grants, schedules, item_comments)
101 (spare)
```

**HTTP:**

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/checkins?mine=participant\|viewer&cursor=` | |
| POST | `/api/checkins` | `{ name, template, participants, schedule }` (template seeds the question set) |
| GET/PATCH/DELETE | `/api/checkins/:id` | settings, schedule (reschedules future rounds) |
| GET/PUT | `/api/checkins/:id/questions` | draft set; `POST …/publish` |
| PUT | `/api/checkins/:id/participants` | people and groups; `PATCH …/participants/me` `{ pausedUntil?, tz? }` |
| GET | `/api/checkins/:id/rounds?cursor=` | round list with participation |
| GET | `/api/checkin-rounds/:rid` | answers grouped by person (or question), blockers on top |
| GET | `/api/checkin-rounds/:rid/me` | your form + prefill suggestions |
| POST/PUT | `/api/checkin-rounds/:rid/answer` | submit/edit; `POST …/skip` |
| GET | `/api/checkins/due` | rounds open for you (Today) |
| GET | `/api/checkins/:id/stats?from=&to=` | participation, streaks, mood trend |

**MCP** (`checkins:read` / `checkins:write`): `list_checkins`, `get_checkin`, `list_checkin_rounds`, `get_checkin_round` (answers the key may read), `get_due_checkins`, `answer_checkin` (`{ round | checkin+date, answers }`, as the key owner), `skip_checkin`, `create_checkin`, `update_checkin`, `set_checkin_participants`, `checkin_stats`, `delete_checkin` (Bin). Prompt `standup_summary` (summarize a round, list blockers). Agents: reads; `answer_checkin` as proposal `checkin_answer` (the person approves before it posts).

**UI:**
- **Check-ins home** (`/checkins`): **Due now** strip (cards with "Answer"), **My check-ins** list (name, cadence "Weekdays 09:30 · your time", participants avatars, your streak 🔥 n, last round participation ring).
- **Answer sheet** (from anywhere): stepper on phones, page on desktop; question roles get smart inputs: `done` with "Suggestions" chips (cards you finished/moved, click to add as `MYT-12` chips), `plan` prefilled from yesterday's plan and today's due cards, `blockers` with card picker and "No blockers" one-tap, `mood` as emoji scale, `goal_update` (W3) as KR rows. "Same as last time" button per text question.
- **Round view** (`/checkins/<slug>-<sid>/<date>`): header with date switcher (‹ ›), participation bar (answered/late/skipped/out avatars), **Blockers** panel, answers by person (cards with avatar, time, answers, reactions, comment thread) or by question toggle; mood summary.
- **Insights**: participation over time, streaks table, mood trend (pulse: aggregates only).
- **Settings**: questions (QuestionSetEditor with roles), schedule (`SchedulePicker`: weekdays, time, zone mode, deadline, reminder, preview of next 5 fires), participants (PersonPicker with groups), viewers (Access sheet), summary options.
- Mobile 375: due cards first; answer sheet full screen with progress dots; round view single column.

**Notifications:** round open (participant, push + inbox; email only if opted), reminder before deadline (pending participants), round summary (followers/viewers who opted), mention in a comment, your blocker was linked to a card (card assignees).
**Schedules:** `checkins.open` (per participant per round, or per round in fixed mode), `checkins.remind`, `checkins.close`.
**Datasets:** `checkins.participation` (checkin, round date, user (null for anonymous checkins), status, answered_at lateness minutes), `checkins.answers` (checkin, round date, question, numeric value / option; text excluded for anonymous).
**Progress sources:** `checkin_average` (a rating/scale question over the period), `checkin_participation` (rate).
**Search:** answers (readers of the round only; anonymous excluded).
**Bin:** `checkin` (with rounds and responses).
**Audit:** `checkins.create|update|delete`, `checkins.participants`, `checkins.answer` (no text), `checkins.skip`, `checkins.questions_publish`.
**Threats:** T550 participants reading others' answers without view → participants get `view` by default (configurable "participants see only their own answers" for 1:1-style check-ins). T551 MCP `answer_checkin` impersonation → only as the key owner, only rounds they participate in. T552 schedule storms with many participants × zones → one schedule per (checkin, participant) with weekday cadence, batch dispatcher. T553 anonymous small-n deanonymization → ≥ 3 threshold, no per-answer timestamps, order shuffled. T554 blocker scanning sets flags on cards the author can't edit → link only (D935).

**Acceptance (browser):** create a Daily standup for a group (3 people, two zones) at 09:30 weekdays; with the test clock, rounds open per zone; answer with suggested cards; blockers referencing `MYT-12` flag the card; second person comments and reacts; third skips; round closes and followers get a summary; pulse check-in hides results until 3 answers; 375 px answer flow.
**Acceptance (MCP):** `get_due_checkins` → `answer_checkin` → `get_checkin_round` shows the answer; agent proposal flow; `checkin_stats`.
**Tests:** `tests/checkins*.test.ts` (round generation across zones and DST, states/streaks, prefill queries, blockers linking/flags, anonymous threshold, MCP, purge), `tests/checkinsClient.test.tsx`.

### D.5 CRM (lane CRM, module `crm`)

**Decisions D960–D999**, threats **T560–T574**, migrations **102–105**. Builds on the foundation people tables (088).

Key decisions:
- **D960** Dedicated tables, not Collections rows: contacts need identity (dedupe by email, upsert from bookings/forms), relations (company, deals), and typed queries for pipelines; Collections stays the generic tables module. CRM **reuses Collections' field engine** (`server/collections/schema.ts` field types and validation, the table cell editors) for custom fields stored in `custom_json`, adding two field types `person` and `contact` in the engine (shared code, D961).
- **D961** Collections field engine gains `person` and `contact` types (CRM lane edits `server/collections/schema.ts` append-only: new rows in `FIELD_TYPES` and their validators; Collections UI shows them read-only until W3 adds editors there).
- **D962** Pipelines belong to a contact book; stages have kind `open | won | lost` and probability; a deal's status derives from its stage kind; won/lost stamp `closed_at`.
- **D963** Interactions are first-class rows linked to any number of contacts/companies/deals; automatic interactions (booking, form, task done) carry `source` and are editable.
- **D964** Rotting: a deal is rotting when its last interaction/stage change is older than the stage's `rot_days` (book default 14).
- **D965** Merge keeps the target's non-empty fields, unions channels/tags/links/interactions, rewrites references (deals, bookings, responses, time targets) in one transaction, and records `merged_from` in activity.
- **D966** CSV import is two-step: upload → preview with mapping, dedupe decisions (create / update existing / skip) → commit as one job (≤ 10 000 rows, chunked transactions with progress, undo by job id within 24 h).

**Tables:**

```
102 crm
pipelines(id, book_id → contact_books CASCADE, name ≤ 80, currency, position, created_at, updated_at, deleted_at NULL)
pipeline_stages(id, pipeline_id → pipelines CASCADE, name ≤ 60, kind CHECK IN ('open','won','lost'), probability INTEGER CHECK 0..100,
  rot_days INTEGER NULL CHECK 1..365, color, position)
deals(id, short_id, book_id → contact_books CASCADE, pipeline_id → pipelines CASCADE, stage_id → pipeline_stages,
  title ≤ 200, value_minor INTEGER NULL ≥ 0, currency, expected_close_on DATE NULL, owner_id NULL,
  company_id NULL → companies SET NULL, next_step ≤ 200 NULL, next_step_on DATE NULL,
  status CHECK IN ('open','won','lost'), closed_at NULL, lost_reason ≤ 200 NULL, stage_entered_at,
  last_activity_at, position REAL, custom_json ≤ 16384, tags_json ≤ 2048, BIN, revision, created_at, updated_at)
  idx (pipeline_id, stage_id, position) WHERE deleted_at IS NULL, (owner_id, status), (expected_close_on)
deal_contacts(deal_id → deals CASCADE, contact_id → contacts CASCADE, role ≤ 40, PRIMARY KEY(deal_id, contact_id))
deal_stage_changes(id, deal_id → deals CASCADE, from_stage_id NULL, to_stage_id, value_minor, actor_id, at)  -- velocity/funnel dataset
interactions(id, book_id → contact_books CASCADE, kind CHECK IN ('note','call','meeting','email','message','task','booking','form','other'),
  direction CHECK IN ('in','out','none'), occurred_at, duration_s NULL, title ≤ 200, body_md ≤ 20000, author_id NULL,
  source CHECK IN ('manual','booking','form','task','import','mcp'), source_ref ≤ 80 NULL, created_at, updated_at)
interaction_subjects(interaction_id → interactions CASCADE, subject_kind CHECK IN ('contact','company','deal'), subject_id,
  PRIMARY KEY(interaction_id, subject_kind, subject_id))  idx (subject_kind, subject_id)
crm_lists(id, short_id, book_id, name ≤ 80, entity CHECK IN ('contact','company','deal'), created_by, created_at, updated_at, deleted_at NULL)
crm_list_members(list_id → crm_lists CASCADE, item_id, added_by, added_at, PRIMARY KEY(list_id, item_id))
crm_views(id, book_id, entity, name ≤ 60, kind CHECK IN ('table','board'), config_json ≤ 8192, owner_id NULL (NULL = shared), position)
crm_followups(id, book_id, subject_kind, subject_id, user_id, due_at, note ≤ 500, done_at NULL, schedule_id NULL, created_at)
crm_import_jobs(id, book_id, user_id, entity, status, mapping_json, stats_json, created_at, finished_at, undo_until)
103 crm_fts (contacts names/emails/company, companies name/domain, deals title, interactions body) + triggers
104 purge triggers (work_links, item_activity, item_comments, schedules for crm kinds; responses/bookings contact refs SET NULL)
105 (spare)
```

**HTTP** (all under `/api/crm`):

| Method | Path | Notes |
| --- | --- | --- |
| CRUD | `/books[/:id]` | + `/fields` (custom field defs), settings, Access sheet as other kinds |
| GET/POST | `/contacts?book=&q=&list=&view=&filter=&sort=&cursor=` | filters on any field incl. custom |
| GET/PATCH/DELETE | `/contacts/:id` | GET includes channels, company, deals, last interactions |
| POST | `/contacts/:id/merge` | `{ intoId }` (D965) |
| GET | `/contacts/duplicates?book=` | candidate pairs (email, name+company) |
| CRUD | `/companies[/:id]` | + `/merge` |
| CRUD | `/pipelines[/:id]`, `/pipelines/:id/stages` | reorder stages |
| GET/POST | `/deals?pipeline=&stage=&owner=&status=&cursor=` | |
| GET/PATCH/DELETE | `/deals/:id` | PATCH `{ stageId, position }` from the board |
| GET | `/pipelines/:id/board` | stages with deals (paged per stage) and totals (sum, weighted) |
| GET/POST | `/interactions?subject=kind:id&cursor=` | timeline; PATCH/DELETE `/interactions/:id` |
| CRUD | `/lists[/:id]`, `/lists/:id/members` | |
| CRUD | `/views[/:id]` | |
| POST | `/followups`; PATCH `/followups/:id` | remind me / done |
| POST | `/import` (multipart) → `{ jobId, preview }`; POST `/import/:jobId/commit`; POST `/import/:jobId/undo` | |
| GET | `/export.csv?entity=&book=&view=`; `/contacts/:id/vcard` | |
| GET | `/records/:kind/:id/timeline` | interactions + activity + linked items merged |

**MCP** (`crm:read` / `crm:write`): `list_contact_books`, `search_crm` (`{ q, entity? }`), `list_contacts`, `get_contact`, `create_contact`, `update_contact`, `upsert_contact` (by email), `merge_contacts`, `bulk_upsert_contacts` (≤ 100, dryRun), `list_companies`, `get_company`, `create_company`, `update_company`, `list_pipelines`, `list_deals`, `get_deal`, `create_deal`, `update_deal` (stage by name or id), `bulk_update_deals`, `log_interaction` (`{ kind, occurredAt?, title, body, subjects: WorkRef[] }`), `list_interactions`, `create_followup`, `pipeline_summary` (by stage: count, sum, weighted), `delete_contact|company|deal` (Bin). Agents: reads; writes as proposals `contact_create`, `contact_update`, `deal_create`, `deal_update`, `interaction_log`; prompt `pipeline_review`.

**UI:**
- **CRM home** (`/crm`): left nav (desktop) / top tabs (phone): **Contacts**, **Companies**, **Deals**, **Lists**, **Insights**; book switcher (All books or one).
- **Tables** (contacts, companies): Collections-like grid (column picker, sort, filter chips, saved views, inline edit of simple fields, bulk select → add to list / set owner / tag / delete), search box, **+ New**, **Import**.
- **Record page** (`/crm/contacts/<slug>-<sid>`): header (avatar, name, title @ company chip, owner, lifecycle chip, quick actions: Log interaction, Remind me, Create task, Start timer (Time), Send booking link (W3), Email (mailto)), left column fields (core + custom, editable), right **Timeline** (interactions + activity + comments + linked bookings/responses/cards/time, filter chips), Deals panel, Lists.
- **Deal board** (`/crm/deals?pipeline=`): `<KanbanBoard>` columns = stages with count, sum, weighted sum; cards: title, value, company/contact chips, owner avatar, next step date (red if past), rotting dot; drag between stages (won/lost asks for reason when lost); table view toggle; pipeline settings sheet (stages, probabilities, rot days).
- **Deal page**: like record page plus stage progress stepper, value/close date, contacts with roles.
- **Import**: upload → mapping table (CSV column → field, auto-matched) → dedupe preview counts → commit with progress → result + Undo.
- Mobile 375: tables become lists (name, subtitle, one metric); deal board shows one stage at a time with a stage strip (Tasks' phone board pattern).

**Notifications:** follow-up due, deal assigned to you, deal won/lost (book followers opted in), mention in an interaction/comment, import finished.
**Schedules:** `crm.followup`, `crm.rotting` (daily per book: notify owners of newly rotting deals).
**Datasets:** `crm.contacts` (book, lifecycle, owner, source, created_at, last_interaction_at), `crm.deals` (pipeline, stage, status, value, currency, owner, expected_close_on, created_at, closed_at), `crm.deal_stage_changes`, `crm.interactions` (kind, author, occurred_at, subject kinds).
**Progress sources:** `crm_won_value`, `crm_won_count`, `crm_pipeline_value` (pipeline, period, owner filter).
**Search:** contacts (name, emails, phones, company), companies (name, domain), deals (title), interactions (body; readers of the book).
**Bin:** `contact_book`, `contact`, `company`, `deal`.
**Audit:** `crm.book_*`, `crm.contact_create|update|delete|merge`, `crm.company_*`, `crm.deal_*` (stage changes with from/to ids), `crm.interaction_*`, `crm.import_commit|undo`, `crm.export`.
**Threats:** T560 PII exposure (emails/phones) to people without book access → resolver redaction, search filtered by readable books, MCP keys need `crm:read` + book grant. T561 CSV import injection/zip bombs → CSV only, 5 MiB, 10 000 rows, parser limits; export formula escaping. T562 merge across books → refused (same book only). T563 upsert overwriting data (bookers changing a contact's name) → D806 fill-empty only. T564 mass export by a compromised key → export counts against a daily bucket, audited. T565 vCard/CSV header injection → quoted, CRLF stripped. T566 agent proposals exfiltrating contacts into chats → agent tool results capped and redacted of channels unless the agent's scope includes them (agents see emails only via `get_contact`).

**Acceptance (browser):** create a book, custom fields (select, person), import 200-row CSV with 10 duplicates (preview shows them; choose update), undo, re-import; record page with timeline; log a call; remind me tomorrow (notification fires with test clock); pipeline with 5 stages; drag deals; lost reason; rotting dot after clock jump; merge two contacts and see deals/bookings move; Insights pipeline by stage; 375 px list and stage strip.
**Acceptance (MCP):** `upsert_contact` → `create_deal` → `update_deal stage="Won"` → `pipeline_summary`; `log_interaction` with a contact and a deal; chosen-book key can't see another book.
**Tests:** `tests/crm*.test.ts` (dedupe/upsert/merge, import job + undo, board ordering/moves, totals/weighted, rotting, custom fields via the Collections engine, search, MCP, purge orphans), `tests/crmClient.test.tsx`.

### D.6 Bookings (lane BOOK, module `bookings`)

**Decisions D1000–D1039**, threats **T575–T594**, migrations **106–109**.

Key decisions:
- **D1000** Availability = schedule rules (weekly ranges + overrides, in the schedule's zone) minus busy time from the host's chosen Nook calendars (timed events, recurring expanded; all-day events optional per type) minus existing bookings (including pending) with buffers; then notice, horizon, interval, and daily/weekly limits. Computed server-side for a bounded window (≤ 62 days per request).
- **D1001** Booking creation is one transaction that re-computes availability for that slot under a per-host lock (SQLite single writer + `bookings_host_slot` check), so two bookers can't take the same slot (T576).
- **D1002** Events created for bookings live in the host's calendar, linked to the booking by a `work_links` row (not `event_links`, whose `target_type` is CHECK-listed; D804), with the intake answers in the description (visible to the calendar's readers); busy-only feeds keep showing "Busy".
- **D1003** Bookers are upserted into the type's contact book (if set) with D806 rules; their identity on the booking itself is name/email as typed.
- **D1004** Manage links (reschedule/cancel) are per-booking tokens in `public_links` (`booking_manage`), valid until the booking ends; reschedule creates a new booking linked via `rescheduled_from_id` and cancels the old one.
- **D1005** Round-robin picks among available hosts the one with the fewest bookings in the last 30 days for that type, ties by priority then least recently booked; collective requires every host free and puts the event on each host's calendar (one event per host, linked).
- **D1006** Public profile handles are unique, lower-case `[a-z0-9-]{3,30}`, reserved words refused; changing a handle keeps the old one as an alias for 90 days.
- **D1007** Manual approval: booking `pending` holds the slot; host approves/declines from notification; pending expires after `pending_hours` (default 24) via schedule.
- **D1008** Without mail configured, public booking still works but the confirmation page tells the booker to save the manage link; email verification can't be enabled.

**Tables:**

```
106 bookings
booking_profiles(user_id PK → users CASCADE, handle ≤ 30 UNIQUE, display_name ≤ 80, welcome_md ≤ 2000, tz, enabled 0/1, created_at, updated_at)
booking_handle_aliases(handle PK, user_id, expires_at)
availability_schedules(id, user_id → users CASCADE, name ≤ 60, tz, rules_json ≤ 4096 ({ mon: [{from:"09:00",to:"12:00"},…], … }),
  is_default 0/1, created_at, updated_at)  unique (user_id) WHERE is_default = 1
availability_overrides(id, schedule_id → availability_schedules CASCADE, date DATE, ranges_json ≤ 1024 NULL (NULL = unavailable), note ≤ 100,
  UNIQUE(schedule_id, date))
booking_types(id, short_id, owner_id, slug ≤ 60, title ≤ 120, description_md ≤ 4000, durations_json ≤ 128 ([30] or [15,30,60]),
  location_kind CHECK IN ('in_person','phone','video_link','custom','ask'), location_value ≤ 500,
  assignment CHECK IN ('single','round_robin','collective'), schedule_id NULL, calendar_id NULL (where events land, single),
  busy_calendar_ids_json ≤ 1024, include_all_day_busy 0/1, buffer_before_min, buffer_after_min CHECK 0..240,
  min_notice_min CHECK 0..43200, max_days_ahead CHECK 1..365, slot_interval_min CHECK IN (5,10,15,20,30,60),
  daily_limit NULL, weekly_limit NULL, confirm CHECK IN ('auto','manual'), pending_hours CHECK 1..168,
  verify_email 0/1, contact_book_id NULL → contact_books SET NULL, card_json ≤ 2048 NULL ({ boardId, columnId, titleTemplate, assignHost }),
  reminders_json ≤ 512 ([1440, 60] minutes before; booker + host flags), color, public 0/1, status CHECK IN ('active','hidden'),
  visibility, share_role, BIN, revision, created_at, updated_at, UNIQUE(owner_id, slug))
booking_type_hosts(type_id → booking_types CASCADE, user_id → users CASCADE, priority INTEGER, calendar_id NULL, schedule_id NULL,
  PRIMARY KEY(type_id, user_id))
bookings(id, short_id, type_id → booking_types, host_id → users, start_utc, end_utc, duration_min, booker_tz,
  status CHECK IN ('pending','confirmed','cancelled','declined','expired','completed','no_show'),
  booker_name ≤ 120, booker_email ≤ 254, booker_email_norm, guests_json ≤ 2048 (≤ 10 emails), location_resolved ≤ 500,
  contact_id NULL → contacts SET NULL, response_id NULL → responses SET NULL, card_id NULL → cards SET NULL,
  rescheduled_from_id NULL → bookings SET NULL, cancel_reason ≤ 500 NULL, cancelled_by CHECK IN ('host','booker','system') NULL,
  source CHECK IN ('public','secret_link','internal','mcp'), created_by NULL (internal), created_at, updated_at, revision)
  idx (host_id, start_utc) WHERE status IN ('pending','confirmed'), (type_id, start_utc), (booker_email_norm, type_id, status)
booking_events(booking_id → bookings CASCADE, host_id, event_id → events SET NULL, PRIMARY KEY(booking_id, host_id))
107 bookings_fts + purge triggers (work_links, item_members, public_links, schedules)
108–109 (spare)
```

**HTTP:**

| Method | Path | Notes |
| --- | --- | --- |
| GET/PUT | `/api/bookings/profile` | handle, name, welcome, enabled (policy `public_booking_pages` for public) |
| CRUD | `/api/bookings/schedules[/:id]`, `/overrides` | |
| CRUD | `/api/bookings/types[/:id]` | + `/hosts`, intake questions (`/questions` draft/publish via §B.2) |
| GET | `/api/bookings/types/:id/slots?from=&to=&tz=&duration=` | internal preview |
| POST | `/api/bookings/types/:id/secret-links` | one-off/expiring token; DELETE to revoke |
| GET | `/api/bookings?status=&from=&to=&type=&cursor=` | host/manager list |
| POST | `/api/bookings` | internal booking (member books a colleague's type) |
| GET | `/api/bookings/:id` | |
| POST | `/api/bookings/:id/approve` · `/decline` · `/cancel` · `/reschedule` · `/no-show` | host actions with optional message |
| GET | `/api/public/book/:handle` | profile + public types |
| GET | `/api/public/book/:handle/:slug` · `/api/public/book/link/:token` | type + intake + nonce |
| GET | `/api/public/book/…/slots?from=&to=&tz=&duration=` | rate-limited, max 31 days per call, cached 30 s |
| POST | `/api/public/book/…/bookings` | `{ start, duration, tz, name, email, guests?, answers, nonce, hp, t }` → `{ status, manageUrl?, verify? }` |
| POST | `/api/public/bookings/verify` | email code |
| GET/POST | `/api/public/bookings/manage/:token` | view, cancel `{ reason }`, reschedule `{ start }` |
| GET | `/api/public/bookings/manage/:token/ics` | ICS of the booking |

**MCP** (`bookings:read` / `bookings:write`): `list_booking_types`, `get_booking_type`, `create_booking_type`, `update_booking_type`, `get_availability` (`{ type, from, to, tz }` → slots), `list_bookings`, `get_booking`, `create_booking` (internal, as the key owner or for a contact: `{ type, start, booker: PersonRef | { name, email } }`), `cancel_booking` (host side, needs `bookings:write`), `reschedule_booking`, `approve_booking`, `decline_booking`, `mark_no_show`, `get_booking_link` (public URL when public; else none), `delete_booking_type` (Bin). Agents: reads + `get_availability` + `create_booking` (internal only, as proposal unless allowed); never cancel/decline.

**UI:**
- **Bookings home** (`/bookings`): tabs **Upcoming** (grouped by day, pending first with Approve/Decline), **Past**, **Cancelled**; **Booking types** (cards: color bar, title, durations, location icon, hosts, "Copy link", toggle active, ⋯ secret link); **Availability** (schedules: weekly editor with day rows and time ranges, add range, copy to all days; overrides calendar); **Profile** (handle, preview).
- **Type editor**: sections General, When (schedule, durations, buffers, notice, horizon, interval, limits), Where (location), Hosts (assignment, people), Calendars (busy and target), Intake (QuestionSetEditor; name/email always first), After booking (contact book, create card template, reminders, confirmation), Public (public toggle, verification). Live **slot preview** at right on desktop.
- **Public pages** (`/p/book/<handle>`, `/p/book/<handle>/<slug>`, `/p/book/link/<token>`): PublicPageShell, host card, type list → month calendar with available days → time list in the booker's zone (zone picker) → details form (name, email, guests, intake) → confirmation (summary, add to calendar ICS, manage link). Manage page: details + Reschedule / Cancel.
- **Booking detail sheet** (host): booker, contact chip (open in CRM), answers, event link, card link, notes (ItemTimeline), actions.
- Mobile 375: public flow is single column steps; Upcoming list cards; schedule editor rows wrap ranges to a second line ("two rows, nothing hidden").

**Notifications:** new booking / pending request / cancelled / rescheduled (hosts, push + email by prefs); reminders to hosts (push) and bookers (email); daily "today's bookings" via Today/digest.
**External mail templates:** `bookings.confirmed`, `bookings.pending`, `bookings.declined`, `bookings.cancelled`, `bookings.rescheduled`, `bookings.reminder`, `bookings.verify` (ICS attached via `server/calendar/ics.ts`).
**Schedules:** `bookings.remind` (per booking × offset), `bookings.pending_expire`, `bookings.complete` (mark completed after end).
**Datasets:** `bookings.bookings` (type, host, status, start, duration, lead time hours, source, created_at; no booker PII).
**Search:** bookings (booker name/email for hosts/managers), types.
**Bin:** `booking_type` (bookings remain, type shown as "Deleted type").
**Audit:** `bookings.type_*`, `bookings.profile_update`, `bookings.create` (source), `bookings.approve|decline|cancel|reschedule|no_show`, `bookings.secret_link_*`.
**Threats:** T575 public slot scraping reveals calendar patterns → slots only (no event details), 31-day windows, rate limits, profile disabled by default. T576 double booking race → D1001. T577 spam bookings / mail bombing third parties → per-email caps, verification option, per-type hourly cap, external mail caps (§B.7), honeypot/fill-time. T578 manage token leakage via Referer → `no-referrer`, token in path only on our origin, single booking scope, expires at end. T579 handle squatting / impersonation (`/p/book/admin`) → reserved words, admins can reset handles. T580 intake answers injecting into calendar event descriptions shown to members → stored as text, rendered escaped; links not autolinked except `url` answers. T581 timezone manipulation to bypass notice → server computes in UTC. T582 host private calendar details in event created on a shared calendar → booking events default to the host's private calendar; type editor warns when the target calendar is shared. T583 enumeration of bookings via MCP for hosts in other teams → bookings readable by host and type managers only.

**Acceptance (browser):** set profile handle, weekday 09–12/13–17 schedule with an override day off; type "Intro call" 30 min, buffer 10, notice 4 h, busy from your calendar; create a calendar event → slot disappears; book from a private window as an outsider (policy on) with intake answers; host gets notification; event in calendar; contact created in the chosen book with a meeting interaction; prep card created; booker mail in the dev mail log with ICS and manage link; reschedule from the manage page; cancel; manual-approval type → pending → approve; round-robin across two hosts; two concurrent bookings for the same slot → one wins (test + manual); 375 px public flow.
**Acceptance (MCP):** `get_availability` → `create_booking` (internal) → `list_bookings` → `reschedule_booking` → `cancel_booking`.
**Tests:** `tests/bookings*.test.ts` (slot math: zones, DST, overrides, buffers, notice, limits, recurring busy events; concurrency; round-robin/collective; public flow incl. verification and limits; manage tokens; contact upsert; card creation; reminders via test clock; MCP; purge), `tests/bookingsClient.test.tsx`, `tests/bookingsPublic.test.tsx`.

### D.7 Wave 3: wiring (W3-WIRE) and workspace data in Reports (W3-REPORTS)

**W3-WIRE** (migrations **110–112**, decisions **D1040–D1059**, threats **T595–T599**): flows marked W3 in §C:
- C3 form → deal; C5 check-in `goal_update` questions; C6 time in check-in prefill; C15/C20 CRM record panels for Time (entries, start timer) and Bookings (list, "Send booking link" with prefilled hidden fields); C21 respondents on contact timelines; C22 card dialog **Goal** field and board header goal chip (card slot), card face goal badge (setting); C23 round → note append; Collections editors for `person`/`contact` field types (D961); Team page "Book time with …" button; Today quick actions final ordering; digest sections; `scope=all` search ranking polish; AI eval script `scripts/workspaceAgentEval.ts` (scripted provider: an agent logs time from a summary, checks in on a goal, updates a deal, answers a standup, all as proposals); docs (USING sections, site "Using Nook" sections per module, API_CONTRACTS, THREAT_MODEL, TEST_PLAN entries); `tests/docsSite.test.ts` passing with six new modules.
- Migration 110 `wiring` only if needed (e.g. `goals_on_boards` cached chip column); 111–112 spare.

**W3-REPORTS** (migrations **113–114**, decisions **D1060–D1069**, threats **T600–T609**): Reports data source kind `workspace` ("This workspace", always present for members when any module dataset is registered). `report_datasources.kind` CHECK widened (113, 12-step rebuild); a report query on it stores a structured dataset query (`shared/datasets.ts`) in the query's body with `language: "dataset"`; the generator prompt gets the dataset catalog instead of the ClickHouse schema; the SQL editor becomes a structured query editor for this source; runs use the report owner's access (T600, Q3); schedules/filters/parameters map onto `filters`/`timeRange`. Out: joins across datasets (v1 queries are single-dataset; Q3 asks whether cross-dataset SQL is wanted later).

---

## E. Design and UX guidelines

Nook is dark-only with a warm amber accent (`--yellow #f6c453`, focus `--field-focus`), panels `#111113`/`#18181b`, borders `#29292d`, muted `#929299`, 8–10 px radii, `.84rem` controls, sheets on phones, and lucide icons. New modules must be indistinguishable in craft from Tasks and Reports.

### E.1 Principles

1. **One way to do each thing.** Use the shared components (E.3); do not restyle them per module. A second implementation of a picker, chip, timeline, or progress bar is a review blocker.
2. **Content first, chrome quiet.** Lists are dense rows (34–40 px), one primary action per screen (amber filled), secondary actions as ghost buttons or the ⋯ menu.
3. **Every list has an empty state** with one sentence and one action ("No goals in Q1 2027. **New goal**"), using `EmptyState` with the module icon.
4. **Keyboard**: `/` search in module, `n` new, `j/k` move, `Enter` open, `e` edit, `Esc` close sheet, `⌥T` timer, `?` shortcut sheet entries per module (registered).
5. **375 px rule**: toolbars are **two rows, nothing hidden** (the tasks phone toolbar rule, commit 74f26205): row 1 view switch/title, row 2 filter + search; no horizontal scroll except kanban columns and timesheets (which show one column/day at a time with a strip).
6. **Plain words**: "Check in", "Log time", "Respond", "Book", "Link work"; never "OKR instance", "entity", "record type".
7. **Status colors** come from one map (`shared/tones.ts`, W1-CORE): `good` (green), `warn` (amber), `bad` (red/`--red`), `info` (blue), `neutral` (slate); health, deal won/lost, booking status, form status, and participation use it.
8. **Numbers**: tabular figures for durations, money, progress; units always shown (`3h 20m`, `€1,200`, `62%`).
9. **Accessibility**: every chip/button has a name; charts have a table fallback (Reports pattern); color is never the only signal (icons + text on health).

### E.2 Module home scaffold (`src/ui/ModuleHome.tsx`, W1-UI)

Header: module icon + name, primary action, secondary ⋯; a tab strip (`tabStrip.ts`) for the module's top-level views; a filter row (chips + search); content. Desktop ≥ 1280 may show a right detail pane; ≤ 760 uses full-screen sheets (`pickerSheet.css`, `useHistoryDialogGuard`). Every module home uses it, so Forms, Time, Goals, Check-ins, CRM, Bookings share header height, tab style, and spacing.

### E.3 Shared UI components to build once (W1-UI)

| Component | Used by | Notes |
| --- | --- | --- |
| `QuestionSetEditor`, `QuestionRenderer`, `ResponseViewer`, `QuestionSummary` | Forms, Check-ins, Bookings | §B.2; renderer has `theme="app" \| "public"` |
| `PersonChip`, `PersonPicker`, `CompanyChip` | all | users, groups, contacts; inline create contact |
| `WorkRefChip`, `LinkedItemsPanel`, `LinkPicker` | all | resolves refs, redacts unreadable, key paste (`MYT-12`) |
| `ItemTimeline` | Goals, CRM, Check-ins, Bookings, Forms | comments + activity, D746 controls |
| `KanbanBoard` | CRM deals (Goals optional board view) | columns with header totals, pointer drag, phone stage strip |
| `ProgressBar`, `ProgressRing`, `HealthChip` | Goals, Time budgets, Forms funnel, Check-in participation | one visual for "how far along" |
| `DurationInput`, `DurationChip`, `TimerChip` | Time, card slots, Bookings durations | parser from `shared/duration.ts` |
| `MoneyInput`, `MoneyText` | Time rates, CRM deals | `shared/money.ts` |
| `SchedulePicker` | Check-ins, Goals cadence, Forms open/close, Time reminders | weekdays, time, zone mode, preview of next fires |
| `AvailabilityEditor` | Bookings (owned by BOOK lane, but in `src/ui/schedule/` for reuse) | weekly ranges + overrides |
| `InsightChart`, `KpiTile` | every Insights tab | wraps Reports charts and theme |
| `PublicPageShell` | Forms, Polls, Bookings public pages | light theme (E.6) |
| `EmbedCard` | notes/cards embeds of polls, forms, goals, booking links | neutral link text, live content fetched |
| `QuickActions` (Today row) | all | registered per module |
| `EmptyState`, `ModuleHome` | all | E.2 |

### E.4 Patterns per screen type

- **List → detail**: desktop opens detail in a route (full page) with Back; phones the same (no split panes on phones). Detail pages have a header, left fields column (≤ 360 px) and right timeline on ≥ 1280; stacked on smaller widths.
- **Editors** (form, check-in questions, booking type): left navigation of sections on desktop, a stepper of sections on phones, autosave drafts with a "Saved" indicator; explicit **Publish** where the thing is live (forms, check-in questions).
- **Sheets** for quick create/edit (log time, check in, log interaction, new poll), max 560 px on desktop, full-screen on phones, `Esc`/back closes with the leave guard when dirty (`useLeaveGuard`).
- **Insights tabs** use 2–4 KPI tiles on top, then charts, then a table; filters at the top match the module's list filters.

### E.5 Visual QA

Screenshots at 1585, 1280, 390 for every new screen (TODO standing rule); `scripts/buttonMetrics.ts` diff + lint must keep existing screens identical; `scripts/dragSmoke.ts` covers the deal board drag; each lane adds its screens to the button lint.

### E.6 Public pages theme

Public pages are the only light surface: background `#f6f5f2`, card `#ffffff`, text `#18181b`, muted `#6b6b72`, border `#e4e4e7`, accent = the form/type accent (default the Nook amber, darkened to `#b8860b` for contrast on light), 12 px radius card, max width 640 (forms) / 880 (booking calendar + times). Workspace name/logo top-left, "Powered by <app>" footer. Dark mode for public pages follows `prefers-color-scheme` using the app tokens (D831). All contrast ≥ 4.5:1 (checked by test on the token pairs).

---

## F. Build plan

### F.1 Waves

```
Wave 1 (2 lanes, parallel)        Wave 2 (6 lanes, parallel)                         Wave 3 (2–3 lanes)
W1-CORE  server foundations  ─┐   FORMS · TIME · GOALS · CHECKINS · CRM · BOOK  ──►   W3-WIRE   cross-module flows, docs
W1-UI    shared UI + registries ┘                                                     W3-REPORTS workspace data source
                                                                                      (then QA + release, serial)
```

- **Wave 1** must merge to `feat/workspace-modules` before Wave 2 starts. W1-CORE and W1-UI run in parallel; W1-UI codes against W1-CORE's shared types (`shared/*` is written first by W1-CORE in its first commit, within a day, and W1-UI rebases on it).
- **Wave 2** lanes branch from the Wave 1 merge, each in its own worktree, and merge back one at a time (any order). Each lane is self-contained: its module works end to end using foundations and existing modules only. Progress sources and integrations that need another Wave 2 module are registered **in the providing lane's own folder** (TIME registers the `time` progress source in `server/time/progressSource.ts`) against the foundation registry, so no lane waits for another.
- **Wave 3** starts when all six lanes are merged.

Ports and origins (TODO standing rules): W1-CORE 2201, W1-UI 2202, FORMS 2211, TIME 2212, GOALS 2213, CHECKINS 2214, CRM 2215, BOOK 2216, W3-WIRE 2221, W3-REPORTS 2222; origin `<lane>.localhost:<port>`; scratch in `<scratchpad>/<lane>/`.

### F.2 Wave 1 deliverables (exact APIs lanes rely on)

W1-CORE exposes (names are binding; lanes import them):

```ts
// server/workspaceModules.ts
registerWorkspaceModule(def: WorkspaceModuleDef): void
// server/questions/service.ts
saveDraftSet, publishSet, currentSet, submitResponse, updateResponse, deleteResponse, summarize, responsesPage, exportCsv
// shared/questions/*
QUESTION_TYPES, validateQuestionSet, validateAnswers, evaluateLogic, scoreResponse, type Question, type QuestionSet, type Answers
// server/people/contacts.ts
upsertContactByEmail, readableBookIds, contactSummaries, ensureClientsBook
// server/links/service.ts + shared/workRefs.ts
createLink, deleteLink, linksOf, registerWorkKind, resolveRefs, parseWorkRef, type WorkRef, type WorkSummary
// server/activity/*
recordItemActivity, recordItemChange, registerActivityKinds, addComment, listComments
// server/schedules/*
registerScheduleHandler, upsertSchedule, cancelSchedules, nextFires
// server/notify/*
notify, enqueueExternalMail, registerDigestSection
// server/public/*
registerPublicRoutes, createPublicLink, revokePublicLink, readPublicLink, publicLimit, issueRenderNonce, checkSubmission, startEmailVerification
// server/datasets/*
registerDataset, runDatasetQuery
// server/goalsProgress.ts (lives in foundation so every lane can register before GOALS merges)
registerProgressSource(kind, { label, configSchema, describe, compute }), computeProgress
// server/undo.ts
captureUndo, restoreUndo
// server/access/*
item access for the six kinds: itemLevel(kind, id, userId), readableIds(kind, userId), sharing routes generic `/api/access/:kind/:id`
// server/mcpRegistry.ts, server/mcpToolKit.ts
defineTool (+ annotations, outputSchema), registerMcpResource
// shared/duration.ts, shared/money.ts, shared/embeds.ts, shared/tones.ts
```

W1-UI exposes: everything in §E.3, `src/workspaceModules` registry (`WorkspaceClientModule` type), `src/ui/cardSlots.ts` (`registerCardSection`, `registerCardFaceBadge`, `registerCardHeaderAction`, `registerTimelineDecoration`), `src/editor` embed + slash registration (`registerEmbedKind`, `registerSlashItem`), `src/today` quick actions + generic section renderer (`registerTodayRenderer`), Settings rows (notifications per module, policies `public_forms`/`public_booking_pages`, workspace currency, week start, duration format).

**Wave 1 acceptance:** all foundation tests green; the six module stubs are hidden; a throwaway test module (in tests only) registers routes, MCP tool, dataset, schedule, search scope, Today section, card slot, embed, and works end to end in tests; migrations 085–089 apply to a copy of a real 082 database with no lost grants/proposals/notifications; public `/p/test` page renders with the strict headers; Visual QA shows existing screens unchanged (buttonMetrics diff empty).

### F.3 Wave 2 lanes: ownership

Every lane owns, exclusively: `server/<module>/**`, `src/<module>/**`, `shared/<module>*.ts`, `server/migrations/<its ids>_*.ts`, `server/migrations/workspace/<module>.ts`, `tests/<module>*.test.ts(x)`, its section of `docs/plan/WORKSPACE_MODULES.md` ("Decisions as built" under its §D), and its own docs file additions listed below. **Append-only shared edits** (one line or one block each; resolve conflicts by keeping both):

| Lane | Server folder | Client folder | Append-only shared edits |
| --- | --- | --- | --- |
| FORMS | `server/forms/` | `src/forms/` | `docs/plan/API_CONTRACTS.md` (new section), `THREAT_MODEL.md` (T515–T529), `TEST_PLAN.md`, `CHANGELOG.md` Unreleased line, `site/index.html` module section (W3 finalizes) |
| TIME | `server/time/` | `src/time/` | same docs; `scripts/buttonLint.allow.json` if needed |
| GOALS | `server/goals/` | `src/goals/` | same docs |
| CHECKINS | `server/checkins/` | `src/checkins/` | same docs |
| CRM | `server/crm/` | `src/crm/` | same docs; `server/collections/schema.ts` (`person`, `contact` field types, D961) |
| BOOK | `server/bookings/` | `src/bookings/` (+ `src/ui/schedule/AvailabilityEditor.tsx`) | same docs |

Lanes must **not** edit: `server/index.ts`, `server/mcpTools.ts`, `server/mcpScopes.ts`, `server/keyGrants.ts`, `server/keyResources.ts`, `server/moduleIds.ts`, `src/modules.ts`, `src/router.ts`, `src/App.tsx`, `src/AppShell.tsx`, `src/tasks/**` (use card slots), `src/editor/**` (use embed/slash registries), `server/migrations/index.ts`, foundation folders. If a lane needs a registry hook that is missing, it asks the director; W1 owners add it in a small follow-up commit on `feat/workspace-modules` that lanes rebase onto.

Cross-lane dependencies inside Wave 2 are only through foundation tables and registries:
- BOOK writes contacts (088 tables, `upsertContactByEmail`) and cards (Tasks service `createCard`), not CRM code.
- FORMS writes contacts the same way; creates cards via Tasks service.
- TIME reads companies (088) for clients.
- Progress sources: TIME, CRM, FORMS, CHECKINS register theirs in their own folder via `registerProgressSource`; GOALS consumes the registry. GOALS' UI lists whatever is registered.

### F.4 Per-lane acceptance and test plan (summary; full lists in §D)

Each lane's "done" means:
1. Its §D acceptance (browser) passes on its own origin at 1585/1280/390 with screenshots attached to the merge report.
2. Its §D acceptance (MCP) passes via a real MCP client (`scripts/mcpSmoke.ts <lane>` pattern) and over REST v1.
3. Tests: service, routes, access (owner/manage/edit/comment/view/none/guest/viewer role/blocked user), chosen-item key reach, MCP tools (scopes, NOT_FOUND parity, rate buckets), Bin + purge orphans (`tests/support/orphans.ts`), migration test (on a copy of a post-089 DB), client tests for each screen, search, Today section, dataset query with access predicate, notifications and schedules with the test clock (`tests/support/clock.ts`).
4. `bun run typecheck`, `bun --no-env-file test`, `git diff --check`, button lint, and `docker build --target verify` pass.
5. Module `ready: true`, Settings → Modules lists it, turning it off hides launcher/routes/Today/search scope.
6. Its docs entries (API_CONTRACTS, THREAT_MODEL, TEST_PLAN) and "Decisions as built" are written.

### F.5 Wave 3 acceptance

- Every §C flow marked W3 demonstrated in the browser in one scripted walkthrough (`docs/plan/qa/workspace-modules.md` checklist): booking → contact + event + card + CRM timeline + time logged on the booking; form → card + contact + deal; standup with goal updates and blockers; goal auto-progress from tasks, time, CRM, forms, check-ins; card dialog shows Goal and Time; Today shows all six modules' sections and quick actions; search All finds one item per module.
- `scripts/workspaceAgentEval.ts` passes with the scripted provider; a real-model run is recorded as an operator item in TODO.md (as for reports).
- Reports "This workspace" source: generate a report "Hours by client this month", "Pipeline by stage", "NPS by week" with the scripted provider; filters and schedules work; owner-access behavior matches Q3's answer.
- Docs: USING, site sections for six modules (docsSite test), OPERATIONS (public pages policies, external mail caps), CHANGELOG.

### F.6 Lane brief template (copy into each agent prompt)

> You are lane **<LANE>** of docs/plan/WORKSPACE_MODULES.md. Work in your own worktree on a branch from `feat/workspace-modules` (after the Wave 1 merge). Read §0, §B, §D.<n>, §E, §F.3–F.4 and the repo rules in TODO.md "Standing rules for agent briefs". Use only foundation APIs (§F.2) for shared concerns. Own only the files listed for your lane in §F.3; append-only edits elsewhere as listed. Migrations: <ids>. Decisions: <range>. Threats: <range>. Port <port>, origin `<lane>.localhost:<port>`. Done = §F.4. Do not push; report branch, commits, screenshots, test results, and decisions as built.

---

## G. Open questions for the product owner

- **Q1 Outside calendars for Bookings.** v1 checks only Nook calendars for busy time. Do you want, in v1.1, read-only busy sync from Google/Outlook (via the existing Google sign-in integration or an ICS "secret address" fetched through the egress guard)? Without it, people who live in Google Calendar will get double-booked. Recommendation: ICS busy subscription first (no OAuth scopes), Google Calendar API later.
- **Q2 Public pages policy defaults.** Public forms and booking pages are off by default and need an admin to enable. OK, or should Bookings be on by default since it's useless without public pages?
- **Q3 Reports on workspace data.** Should a shared report built on "This workspace" show viewers the data the **owner** can read (consistent numbers, matches how the `nook` doc source works) or each **viewer's** own access (safer, numbers differ by viewer)? Recommendation: owner's access with a visible "Data as seen by <owner>" label, and only for reports shared with people who already read the module. Also: is single-dataset structured querying enough for v1, or is SQL over workspace data required?
- **Q4 Goal roll-up privacy.** A parent goal's progress includes children the viewer can't open (their progress is shown anonymously). Accept, or exclude hidden children per viewer (numbers then differ by viewer)?
- **Q5 Time visibility on cards.** Should anyone who can read a card see its worklogs (Jira behavior, D872 default) or only totals?
- **Q6 Currency.** One workspace currency for v1 with per-project/per-deal override and no conversion. Enough?
- **Q7 Naming.** Module names "Forms" (includes polls), "Time", "Goals", "Check-ins", "CRM", "Bookings". Prefer "Contacts" over "CRM", or "Standups" over "Check-ins"?
- **Q8 Guests.** Guests can answer forms/check-ins shared with them and read goals shared with them, nothing else in the new modules. Should guests be bookable hosts or log time (contractors)? Recommendation: allow guests to log time on projects they're members of (`time_project` member) — a common contractor case.
- **Q9 Email to outsiders.** Bookings and time polls email people outside the workspace. Is that acceptable for your mail provider/domain reputation, with the caps in §B.7?

### G.1 Product owner answers (2026-11-13) — these override the defaults above

- **Q1 → ICS busy feed in v1.** Each host can add one or more private ICS URLs (Google/Outlook "secret address"); BOOK fetches them through the egress guard on a schedule (and on demand before offering slots, with a short cache), expands recurrences, and treats them as busy. Stored URLs are secrets (encrypted at rest like other credentials, never returned in full to the client or MCP). Google OAuth sync stays out of scope.
- **Q2 → Public pages ON by default.** The admin policy for public forms, polls and booking pages defaults to **enabled**; admins can turn each off in Settings. All anti-abuse controls in §B.8 stay mandatory, and the `/security-review` of public routes remains a release gate.
- **Q5 → Worklogs visible to everyone who can read the card** (D872 default as written).
- **Q7 → Names:** **Contacts** (companies and deals live inside it; the module id may stay `crm` internally, but every user-facing label, nav entry and URL says Contacts: `/contacts/...`), **Standups** (user-facing name for the check-ins module, `/standups/...`; it still covers retros and pulse surveys as standup templates), and **Forms**, **Time**, **Goals**, **Bookings** unchanged.
- **New module: Townhall** (the product owner added it). An all-hands / AMA module in the Slido / Mentimeter / Pigeonhole space, built on the shared question engine and Polls: a Townhall session (optionally linked to a Calendar event) collects questions before and during the meeting; people ask named or anonymous (if the host allows), upvote, and comment; moderators approve/hide/merge/mark answered and pin the current question; live polls, word clouds and ratings run during the session; a presenter view (large, high-contrast, auto-updating) for screen share; after the session a recap (answered/unanswered, poll results, notes link) is posted and open questions can become cards. MCP: list/get sessions, ask, upvote, moderate (scoped), export recap. Lane **TOWNHALL**: migrations 115–117, decisions D1070–D1099, threats T610–T619, port 2223, origin `townhall.localhost:2223`; it depends on FORMS' poll pieces only through Wave 1 foundations (question engine) — live poll widgets it needs are in W1-UI.
- **Defaults chosen by the director for the rest:** Q3 → each **viewer's** own access (numbers may differ by viewer; safer), single-dataset structured queries are enough for v1. Q4 → exclude children the viewer can't open from their roll-up only when shown as a list; the parent's stored progress stays owner-computed and is labelled "includes items you can't open" when any are hidden. Q6 → one workspace currency with per-project/per-deal override, no conversion. Q8 → guests may log time on time projects they are members of; guests cannot be booking hosts. Q9 → yes, with the §B.7 caps.
- **Base:** friendly URLs (migration 083, `shared/friendlyUrls.ts`: `slugify`, short ids, `itemPath`, `LINK_KINDS`; `GET /api/links/:kind/:ref`; `src/friendlyLinks.ts`, `FriendlyLinkGate.tsx`, `src/routeNames.ts`) are already in the base branch. Wave 1 **reuses** them (register the new kinds in `LINK_KINDS`/the resolver) instead of vendoring `shared/shortIds.ts`.

## H. Risks

- **Foundation scope creep delays all six lanes.** Wave 1 is large (5 migrations, ~12 registries, ~15 UI components). Mitigation: W1-CORE lands `shared/*` types first; the throwaway test module proves registries; anything not needed by two lanes moves to the lane.
- **CHECK-list rebuilds (085)** of `api_key_grants`, `proposals`, `notifications`, `team_settings`, plus `access_grants_v` are the riskiest migration in the plan (data loss would break keys and Inbox). Mitigation: 12-step pattern from 039 with copy/verify counts in the migration, a test on a production-shaped DB copy, and the restore drill before release.
- **Registry refactor of App.tsx/router.ts/mcpTools.ts** touches hot shared files; regressions there affect every module. Mitigation: W1-UI keeps existing routes untouched (registry only for new modules), route tests for every existing path.
- **Merge conflicts with PR #3 and the friendly-URLs lane** (083–084, D770–D789): both edit `router.ts`, card dialog, and possibly `shortIds`. Mitigation: Wave 1 starts after friendly URLs merges into the base, or W1 vendors the short-id spec and W3 dedupes.
- **Bookings correctness** (time zones, DST, recurring busy expansion, concurrency) is the highest-defect area; test with a matrix of zones and the test clock; manual QA across a DST boundary.
- **Public pages** are Nook's first anonymous write surface (chat links are read-only). Abuse, spam mail, and DoS are real; the policy defaults off and the security review (`/security-review`) of BOOK and FORMS public routes is a release gate.
- **Goal auto-progress performance**: recomputing tasks-sourced KRs over large boards on every card change. Debounce + bounded queries + budgets; measure with 50k cards.
- **Reports integration** may not fit the SQL-centric report model cleanly; W3-REPORTS is cut first if late (module Insights already cover in-module reporting).
- **UI consistency across six parallel lanes**: mitigated by mandatory shared components, ModuleHome scaffold, and a design review of each lane's screenshots by one reviewer before merge.
- **SQLite growth**: responses, time entries, kr_values, item_activity, schedule_fires, public_submissions_log grow unbounded except where retention is stated; add retention for `schedule_fires` (90 days) and `kr_values` compaction (D903).
