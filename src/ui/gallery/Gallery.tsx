import { useMemo, useState, type ReactNode } from "react";
import { BarChart3, CalendarClock, ClipboardList, FileText, Plus, Sparkles, Target, Trash2, Upload } from "lucide-react";
import { EmptyState } from "../EmptyState";
import { ModuleHome } from "../ModuleHome";
import { GoalHealthChip, HealthChip, ProgressBar, ProgressRing } from "../progress/Progress";
import { DurationChip, DurationInput, TimerChip } from "../time/Duration";
import { MoneyInput, MoneyText } from "../money/Money";
import { SchedulePicker, type ScheduleValue } from "../schedule/SchedulePicker";
import { CompanyChip, PersonChip, PersonPicker } from "../people/People";
import { LinkedItemsPanel, WorkRefChip } from "../links/WorkLinks";
import { ItemTimeline } from "../activity/ItemTimeline";
import { KanbanBoard, type KanbanItem } from "../kanban/KanbanBoard";
import { InsightChart, KpiRow, KpiTile } from "../insights/Insights";
import { EmbedCard } from "../embeds/EmbedCard";
import { QuestionRenderer } from "../questions/QuestionRenderer";
import { QuestionSetEditor } from "../questions/QuestionSetEditor";
import { QuestionSummary } from "../questions/QuestionSummary";
import { ResponseViewer } from "../questions/ResponseViewer";
import { LivePoll, RatingWidget, WordCloud } from "../live/LiveWidgets";
import { QaList, type QaQuestion } from "../live/QaList";
import { PresenterView } from "../live/PresenterView";
import { PublicDone, PublicPageShell } from "../../public/PublicPageShell";
import { primeUnits } from "../units";
import type { Answers, QuestionSet, SetSummary } from "../../../shared/questions";
import type { PersonSummary } from "../../../shared/people";
import type { WorkLinkView } from "../../../shared/workRefs";
import "../workspace.css";
import "./gallery.css";

/**
 * The shared component gallery (W1-UI visual QA, D839): every workspace-module component with sample
 * data, one per `?c=<name>`, at any width. Only in a build made with VITE_UI_GALLERY=1 (main.tsx);
 * requests the components make are answered here from samples, never sent.
 */
primeUnits({ weekStart: 1 }, { defaultCurrency: "EUR" });

const now = Date.parse("2026-11-13T10:00:00Z");
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

const people: PersonSummary[] = [
  { kind: "user", id: "u1", name: "Ana Silva", email: "ana@example.com" },
  { kind: "user", id: "u2", name: "Ravi Menon", email: "ravi@example.com", former: true },
  { kind: "contact", id: "c1", name: "Jo Park", email: "jo@acme.test", companyName: "Acme", bookId: "b1" },
  { kind: "contact", id: "c2", hidden: true },
  { kind: "group", id: "g1", name: "Design", memberCount: 6 }
];
const links: WorkLinkView[] = [
  { id: "l1", relation: "contributes", direction: "in", source: "work_links", createdAt: iso(90), other: { kind: "card", id: "k1", key: "MYT-12", title: "Ship the onboarding checklist", href: "/tasks/MYT-12", icon: "square-check", status: { label: "Doing", tone: "info" } } },
  { id: "l2", relation: "contributes", direction: "in", source: "work_links", createdAt: iso(80), other: { kind: "goal", id: "g2", title: "Activation above 40%", href: "/goals/activation-1a2b3c4d5e", icon: "target", progress: 0.62, status: { label: "At risk", tone: "warning" } } },
  { id: "l3", relation: "relates", direction: "out", source: "card_relations", createdAt: iso(70), other: { kind: "note", hidden: true } },
  { id: "l4", relation: "source", direction: "out", source: "work_links", createdAt: iso(60), other: { kind: "response", id: "r1", title: "Response from Jo Park", href: "/forms/onboarding-1a2b3c4d5e/responses/r1", icon: "message-square-text" } }
];

const sampleSet: QuestionSet = {
  version: 1,
  sections: [{ id: "s2", title: "A bit about your team", description: "Optional, but it helps us plan." }],
  logic: [{ id: "lg1", when: { all: [{ questionId: "q2", op: "eq", value: "no" }] }, then: { show: ["q3"] } }],
  endings: [],
  questions: [
    { id: "q1", type: "short_text", title: "What's your **name**?", required: true },
    { id: "q2", type: "yes_no", title: "Did the onboarding call help?", required: true },
    { id: "q3", type: "long_text", title: "What was missing?", help: "A sentence or two is plenty." },
    { id: "q4", type: "single_choice", title: "Which plan are you on?", options: [{ id: "o1", label: "Starter" }, { id: "o2", label: "Team" }, { id: "o3", label: "Business" }], allowOther: true },
    { id: "q5", type: "multi_choice", title: "Which modules do you use?", options: [{ id: "m1", label: "Notes" }, { id: "m2", label: "Tasks" }, { id: "m3", label: "Calendar" }, { id: "m4", label: "Reports" }], maxSelect: 3 },
    { id: "q6", type: "rating", title: "How would you rate the docs?", scale: { min: 1, max: 5, icon: "star" } },
    { id: "q7", type: "nps", title: "How likely are you to recommend us to a friend?", required: true },
    { id: "q8", type: "scale", title: "How busy is your week?", scale: { min: 1, max: 5, minLabel: "Quiet", maxLabel: "Packed" }, sectionId: "s2" },
    { id: "q9", type: "matrix", title: "How often do you…", sectionId: "s2", matrix: { rows: [{ id: "r1", label: "Write notes" }, { id: "r2", label: "Plan sprints" }], columns: [{ id: "c1", label: "Daily" }, { id: "c2", label: "Weekly" }, { id: "c3", label: "Rarely" }] } },
    { id: "q10", type: "time_slots", title: "When can you join a follow-up?", sectionId: "s2", allowMaybe: true, slots: [{ id: "t1", start: "2026-11-16T09:00:00Z", end: "2026-11-16T09:30:00Z" }, { id: "t2", start: "2026-11-17T14:00:00Z", end: "2026-11-17T14:30:00Z" }] },
    { id: "q11", type: "contact", title: "How can we reach you?", sectionId: "s2" },
    { id: "q12", type: "ranking", title: "Rank what matters most", sectionId: "s2", options: [{ id: "k1", label: "Speed" }, { id: "k2", label: "Price" }, { id: "k3", label: "Support" }] }
  ]
};

const summary: SetSummary = {
  responses: 48,
  questions: [
    { questionId: "q2", kind: "choice", answered: 48, other: 0, options: [{ optionId: "yes", label: "Yes", count: 35 }, { optionId: "no", label: "No", count: 13 }] },
    { questionId: "q4", kind: "choice", answered: 46, other: 3, options: [{ optionId: "o1", label: "Starter", count: 12 }, { optionId: "o2", label: "Team", count: 24 }, { optionId: "o3", label: "Business", count: 7 }] },
    { questionId: "q7", kind: "nps", answered: 44, promoters: 22, passives: 14, detractors: 8, score: 32, distribution: [] },
    { questionId: "q3", kind: "text", answered: 13, latest: ["A checklist of first steps.", "Shorter call, more examples.", "How to invite the rest of the team."], topWords: [{ word: "checklist", count: 6 }, { word: "examples", count: 4 }, { word: "invite", count: 3 }] },
    { questionId: "q10", kind: "slots", answered: 20, best: "t1", slots: [{ slotId: "t1", yes: 14, maybe: 3, no: 3 }, { slotId: "t2", yes: 9, maybe: 5, no: 6 }] }
  ]
};

const qa: QaQuestion[] = [
  { id: "a1", text: "What is the plan for the mobile app this quarter?", author: "Ana Silva", votes: 24, voted: true, status: "approved", pinned: true, createdAt: iso(30) },
  { id: "a2", text: "Will we keep the Friday demos once the team doubles?", author: null, votes: 17, voted: false, status: "approved", createdAt: iso(25) },
  { id: "a3", text: "How do we decide which customer requests make the roadmap?", author: "Ravi Menon", votes: 9, voted: false, status: "answered", createdAt: iso(40) },
  { id: "a4", text: "Can we get a budget for conference travel?", author: null, votes: 3, voted: false, status: "pending", createdAt: iso(5) }
];

/** Answers the components' requests from samples (the gallery never talks to a server). */
function installSampleApi() {
  const original = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (path.startsWith("/api/links")) return json({ links });
    if (path.includes("/comments") && (init?.method ?? "GET") === "GET") return json({ comments: [
      { id: "m1", itemKind: "goal", itemId: "g1", parentId: null, authorId: "u1", authorName: "Ana Silva", body: "Moved to at risk: the trial-to-paid step dropped this week.", deleted: false, createdAt: iso(120), updatedAt: iso(120), canEdit: true },
      { id: "m2", itemKind: "goal", itemId: "g1", parentId: "m1", authorId: "u2", authorName: "Ravi Menon", body: "The checklist card should help — shipping Monday.", deleted: false, createdAt: iso(100), updatedAt: iso(100), canEdit: false }
    ], nextCursor: null });
    if (path.includes("/activity")) return json({ entries: [
      { id: "e1", itemKind: "goal", itemId: "g1", kind: "created", actorId: "u1", actorName: "Ana Silva", via: null, payload: {}, createdAt: iso(600) },
      { id: "e2", itemKind: "goal", itemId: "g1", kind: "linked", actorId: "u2", actorName: "Ravi Menon", via: "mcp", payload: { item: { id: "k1", label: "MYT-12 Ship the onboarding checklist" } }, createdAt: iso(110) }
    ], nextCursor: null });
    if (path.startsWith("/api/people/search")) return json({ people: people.slice(0, 3) });
    return original(input, init);
  }) as typeof fetch;
}
installSampleApi();

const deals: Array<KanbanItem & { title: string; value: number; contact: string; next: string }> = [
  { id: "d1", columnId: "lead", title: "Acme renewal", value: 1_200_000, contact: "Jo Park", next: "Call Fri" },
  { id: "d2", columnId: "lead", title: "Globex pilot", value: 450_000, contact: "Mia Chen", next: "Email today" },
  { id: "d3", columnId: "proposal", title: "Initech expansion", value: 3_400_000, contact: "Sam Lee", next: "Proposal Mon" },
  { id: "d4", columnId: "won", title: "Umbrella annual", value: 2_100_000, contact: "Lea Roy", next: "Kickoff" }
];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section className="gallery-section" id={id} aria-labelledby={`${id}-h`}><h2 id={`${id}-h`}>{title}</h2>{children}</section>;
}

function Samples({ only }: { only: string | null }) {
  const [seconds, setSeconds] = useState<number | null>(5400);
  const [money, setMoney] = useState<{ amount: number; currency: string } | null>({ amount: 120000, currency: "EUR" });
  const [schedule, setSchedule] = useState<ScheduleValue>({ weekdays: [1, 2, 3, 4, 5], at: "09:30", everyNWeeks: 1, tz: "Europe/Berlin", zoneMode: "fixed" });
  const [picked, setPicked] = useState<PersonSummary[]>([people[0]!, people[2]!]);
  const [items, setItems] = useState(deals);
  const [answers, setAnswers] = useState<Answers>({ q1: "Jo", q2: "no" });
  const [stepAnswers, setStepAnswers] = useState<Answers>({});
  const [set, setSet] = useState<QuestionSet>(sampleSet);
  const [sort, setSort] = useState<"top" | "recent">("top");
  const [questions, setQuestions] = useState(qa);
  const show = (name: string) => only === null || only === name;
  const columns = useMemo(() => [
    { id: "lead", title: "Lead", total: <MoneyText money={{ amount: items.filter((item) => item.columnId === "lead").reduce((sum, item) => sum + item.value, 0), currency: "EUR" }} compact /> },
    { id: "proposal", title: "Proposal", total: <MoneyText money={{ amount: items.filter((item) => item.columnId === "proposal").reduce((sum, item) => sum + item.value, 0), currency: "EUR" }} compact /> },
    { id: "won", title: "Won", total: <MoneyText money={{ amount: items.filter((item) => item.columnId === "won").reduce((sum, item) => sum + item.value, 0), currency: "EUR" }} compact />, marker: <span className="ui-kanban-dot" aria-hidden="true" /> }
  ], [items]);
  return <div className="gallery-body">
    {show("empty") && <Section id="empty" title="EmptyState">
      <EmptyState icon={Target} title="No goals in Q1 2027" action={{ label: "New goal", icon: Plus, onClick: () => undefined }}>Goals you own or follow show here.</EmptyState>
      <EmptyState icon={FileText} title="No responses yet" compact as="h3" />
    </Section>}
    {show("progress") && <Section id="progress" title="ProgressBar, ProgressRing, HealthChip">
      <div className="gallery-stack">
        <ProgressBar label="Grow MRR to €50k" value={0.62} tone="success" target={0.7} />
        <ProgressBar label="Budget used" value={0.84} valueText="42h of 50h" tone="warning" meter />
        <ProgressBar label="Over budget" value={1.12} valueText="56h of 50h" meter />
        <ProgressBar label="Thin" value={0.4} thin tone="info" />
        <div className="gallery-row"><ProgressRing value={0.62} label="Activation" tone="success" /><ProgressRing value={0.35} label="Participation" tone="warning" size={56} stroke={6} large /><ProgressRing value={1} label="Done" tone="info" />
          <GoalHealthChip health="on_track" /><GoalHealthChip health="at_risk" /><GoalHealthChip health="off_track" /><GoalHealthChip health="done" /><GoalHealthChip health="none" /><HealthChip tone="accent" label="Pinned" /></div>
      </div>
    </Section>}
    {show("time") && <Section id="time" title="DurationInput, DurationChip, TimerChip">
      <div className="gallery-grid">
        <DurationInput label="Time spent" value={seconds} onChange={setSeconds} />
        <div className="gallery-row"><DurationChip seconds={12000} /><DurationChip seconds={12000} of={18000} label="Logged" /><DurationChip seconds={21000} of={18000} label="Logged" /></div>
        <div className="gallery-row"><TimerChip running={null} onStart={() => undefined} onStop={() => undefined} shortcut="Alt+T" /><TimerChip running={null} compact onStart={() => undefined} onStop={() => undefined} /></div>
        <div className="gallery-row"><TimerChip running={{ startedAt: new Date(Date.now() - 2_530_000).toISOString(), label: "MYT-12 Ship the onboarding checklist" }} onStart={() => undefined} onStop={() => undefined} onPause={() => undefined} /></div>
      </div>
    </Section>}
    {show("money") && <Section id="money" title="MoneyInput, MoneyText">
      <div className="gallery-grid">
        <MoneyInput label="Deal value" value={money} onChange={(next) => setMoney(next)} />
        <MoneyInput label="Hourly rate" value={{ amount: 9500, currency: "USD" }} onChange={() => undefined} currencyEditable />
        <p className="gallery-row"><MoneyText money={{ amount: 123450, currency: "EUR" }} /> <MoneyText money={{ amount: 120000000, currency: "USD" }} compact /> <MoneyText money={{ amount: 5000, currency: "JPY" }} /></p>
      </div>
    </Section>}
    {show("schedule") && <Section id="schedule" title="SchedulePicker">
      <div className="gallery-narrow"><SchedulePicker label="Standup schedule" value={schedule} onChange={setSchedule} now={now} /></div>
    </Section>}
    {show("people") && <Section id="people" title="PersonChip, CompanyChip, PersonPicker">
      <div className="gallery-row">{people.map((person, index) => <PersonChip key={index} person={person} />)}<CompanyChip name="Acme Inc." domain="acme.test" /></div>
      <div className="gallery-narrow"><PersonPicker label="Attendees" value={picked} onChange={setPicked} allow={["user", "group", "contact"]} onCreateContact={async (contact) => ({ kind: "contact", id: "new", name: contact.name, email: contact.email, bookId: "b1" })} /></div>
    </Section>}
    {show("links") && <Section id="links" title="WorkRefChip, LinkedItemsPanel">
      <div className="gallery-row">{links.map((link) => <WorkRefChip key={link.id} summary={link.other} onOpen={() => undefined} />)}</div>
      <div className="gallery-narrow"><LinkedItemsPanel item={{ kind: "goal", id: "g1" }} canEdit relations={["contributes", "relates"]} onOpen={() => undefined} /></div>
    </Section>}
    {show("timeline") && <Section id="timeline" title="ItemTimeline">
      <div className="gallery-narrow"><ItemTimeline kind="goal" id="g1" canComment /></div>
    </Section>}
    {show("kanban") && <Section id="kanban" title="KanbanBoard">
      <KanbanBoard label="Deals by stage" columns={columns} items={items} itemLabel={(item) => `${item.title}, ${item.contact}`} onOpen={() => undefined}
        onMove={({ itemId, toColumnId, toIndex }) => setItems((current) => {
          const moving = current.find((item) => item.id === itemId)!;
          const rest = current.filter((item) => item.id !== itemId);
          const inColumn = rest.filter((item) => item.columnId === toColumnId);
          const before = inColumn[toIndex];
          const at = before ? rest.indexOf(before) : rest.length;
          rest.splice(at, 0, { ...moving, columnId: toColumnId });
          return rest;
        })}
        renderCard={(item) => <><strong>{item.title}</strong><span className="gallery-row"><MoneyText money={{ amount: item.value, currency: "EUR" }} /><PersonChip size="small" person={{ kind: "contact", id: item.id, name: item.contact, bookId: "b1" }} /></span><small className="gallery-muted">{item.next}</small></>} />
    </Section>}
    {show("insights") && <Section id="insights" title="KpiTile, InsightChart">
      <KpiRow>
        <KpiTile label="Hours this week" value={135000} unit="duration" change={{ text: "+12% vs last week", direction: "up", tone: "success" }} />
        <KpiTile label="Billable" value={0.78} unit="percent" />
        <KpiTile label="Pipeline" value={4850000} unit="money" currency="EUR" change={{ text: "−4%", direction: "down", tone: "danger" }} />
        <KpiTile label="Bookings" value={42} />
      </KpiRow>
      <InsightChart title="Hours by client" kind="bar" unit="duration" categories={["Acme", "Globex", "Initech", "Umbrella"]} series={[{ name: "Billable", values: [36000, 25200, 14400, 9000] }, { name: "Not billable", values: [7200, 3600, 1800, 0] }]} />
    </Section>}
    {show("embed") && <Section id="embed" title="EmbedCard">
      <div className="gallery-narrow gallery-stack">
        <EmbedCard icon={BarChart3} word="Poll" title="Team lunch: where?" subtitle="Poll · 12 votes" action={{ label: "Open", onClick: () => undefined }}>
          <LivePoll question="Team lunch: where?" options={[{ id: "a", label: "Ramen" }, { id: "b", label: "Tacos" }, { id: "c", label: "Salad bar" }]} counts={{ a: 7, b: 4, c: 1 }} myVote={["a"]} onVote={() => undefined} />
        </EmbedCard>
        <EmbedCard icon={Target} word="Goal" title="Activation above 40%" subtitle="Goal · Q4 2026" action={{ label: "Open", onClick: () => undefined }}><ProgressBar label="Progress" value={0.62} tone="warning" target={0.75} thin /></EmbedCard>
        <EmbedCard icon={ClipboardList} word="Form" unavailable />
      </div>
    </Section>}
    {show("question-editor") && <Section id="question-editor" title="QuestionSetEditor">
      <QuestionSetEditor set={set} onChange={setSet} saveState="saved" onPublish={() => undefined} roles={["done", "plan", "blockers", "mood"]} />
    </Section>}
    {show("question-page") && <Section id="question-page" title="QuestionRenderer (page)">
      <div className="gallery-narrow"><QuestionRenderer set={sampleSet} answers={answers} onChange={setAnswers} onSubmit={() => undefined} timeZone="Europe/Berlin" /></div>
    </Section>}
    {show("question-stepper") && <Section id="question-stepper" title="QuestionRenderer (stepper)">
      <div className="gallery-narrow"><QuestionRenderer set={{ ...sampleSet, questions: sampleSet.questions.filter((question) => ["q7", "q4", "q6"].includes(question.id)) }} mode="stepper" answers={stepAnswers} onChange={setStepAnswers} onSubmit={() => undefined} /></div>
    </Section>}
    {show("response") && <Section id="response" title="ResponseViewer">
      <div className="gallery-narrow"><ResponseViewer set={sampleSet} position={3} total={48} onPrev={() => undefined} onNext={() => undefined} onDelete={() => undefined} showScore timeZone="Europe/Berlin"
        response={{ id: "r1", hostKind: "form", hostId: "f1", setVersion: 2, status: "submitted", score: 7, revision: 1, submittedAt: iso(240), updatedAt: iso(240), respondent: { kind: "contact", name: "Jo Park", email: "jo@acme.test" },
          answers: { q1: "Jo", q2: "no", q3: "A checklist of first steps would have helped.", q4: "o2", q5: { options: ["m1", "m2"] }, q6: 4, q7: 9, q9: { r1: "c1", r2: "c2" }, q10: { t1: "yes", t2: "maybe" }, q11: { name: "Jo Park", email: "jo@acme.test", company: "Acme" }, q12: ["k3", "k1", "k2"] } }} /></div>
    </Section>}
    {show("summary") && <Section id="summary" title="QuestionSummary">
      <QuestionSummary set={sampleSet} summary={summary} />
    </Section>}
    {show("live") && <Section id="live" title="LivePoll, WordCloud, RatingWidget">
      <div className="gallery-grid">
        <LivePoll question="Which topic should we cover first?" options={[{ id: "a", label: "Roadmap" }, { id: "b", label: "Hiring" }, { id: "c", label: "Q4 numbers" }]} counts={{ a: 41, b: 18, c: 27 }} onVote={() => undefined} />
        <LivePoll question="Which topic should we cover first?" options={[{ id: "a", label: "Roadmap" }, { id: "b", label: "Hiring" }, { id: "c", label: "Q4 numbers" }]} counts={{ a: 41, b: 18, c: 27 }} myVote={["a"]} onVote={() => undefined} />
        <WordCloud prompt="One word for this quarter?" onSubmit={() => undefined} words={[{ text: "growth", count: 24 }, { text: "focus", count: 18 }, { text: "busy", count: 12 }, { text: "fun", count: 9 }, { text: "hiring", count: 7 }, { text: "shipping", count: 6 }, { text: "calm", count: 3 }, { text: "chaos", count: 2 }, { text: "learning", count: 5 }, { text: "teamwork", count: 8 }]} />
        <RatingWidget prompt="How useful was this session?" value={4} onRate={() => undefined} average={4.3} count={86} distribution={{ 5: 44, 4: 28, 3: 9, 2: 3, 1: 2 }} />
      </div>
    </Section>}
    {show("qa") && <Section id="qa" title="QaList">
      <div className="gallery-narrow"><QaList questions={questions} sort={sort} onSort={setSort} moderator onModerate={() => undefined}
        onUpvote={(id, voted) => setQuestions((current) => current.map((question) => question.id === id ? { ...question, voted, votes: question.votes + (voted ? 1 : -1) } : question))}
        onAsk={async (text, anonymous) => setQuestions((current) => [...current, { id: String(current.length + 1), text, author: anonymous ? null : "You", votes: 0, voted: false, status: "pending", createdAt: new Date().toISOString(), mine: true }])} /></div>
    </Section>}
    {show("public") && <PublicPageShell workspaceName="Acme" appName="Nook" title="Customer onboarding survey">
      <p className="ui-public-text">Five minutes. Your answers go to the onboarding team only.</p>
      <QuestionRenderer set={{ ...sampleSet, questions: sampleSet.questions.slice(0, 7) }} theme="public" audience="public" answers={answers} onChange={setAnswers} onSubmit={() => undefined} />
    </PublicPageShell>}
    {show("public-done") && <PublicPageShell workspaceName="Acme" appName="Nook" accent="#2563eb"><PublicDone title="Thanks, your answers are in">You can close this page.</PublicDone></PublicPageShell>}
  </div>;
}

export function Gallery() {
  const params = new URLSearchParams(window.location.search);
  const only = params.get("c");
  const [presenting, setPresenting] = useState(only === "presenter");
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");
  if (only === "presenter" || presenting) return <PresenterView title="All-hands · November" joinText="Join at nook.example/t/allhands" joinCode="7KQ2" position="2 / 4" onExit={() => setPresenting(false)} onNext={() => undefined} onPrev={() => undefined}>
    <LivePoll presenter question="Which topic should we cover first?" options={[{ id: "a", label: "Roadmap" }, { id: "b", label: "Hiring" }, { id: "c", label: "Q4 numbers" }]} counts={{ a: 41, b: 18, c: 27 }} />
  </PresenterView>;
  if (only === "public" || only === "public-done") return <Samples only={only} />;
  if (only === "module-home") return <ModuleHome icon={Target} title="Goals" heading="Q1 2027 goals" displayName="Ana Silva" onHome={() => undefined} onSettings={() => undefined} onSignOut={() => undefined}
    primary={{ label: "New goal", icon: Plus, onClick: () => undefined }}
    menu={[{ id: "import", label: "Import from CSV", icon: Upload, onSelect: () => undefined }, { id: "bin", label: "Open the Bin", icon: Trash2, onSelect: () => undefined }]}
    tabs={[{ id: "all", label: "All goals", count: 12 }, { id: "mine", label: "Mine", count: 4 }, { id: "insights", label: "Insights" }]} activeTab={tab} onTab={setTab}
    filters={<><button type="button" className="ui-filter-chip" aria-pressed="true"><Sparkles aria-hidden="true" />Q1 2027</button><button type="button" className="ui-filter-chip"><Plus aria-hidden="true" />Filter</button></>}
    search={{ value: query, onChange: setQuery, placeholder: "Search goals", label: "Search goals" }}
    detail={<><h2 className="gallery-detail-title">Activation above 40%</h2><ProgressBar label="Progress" value={0.62} tone="warning" target={0.75} /></>}>
    <EmptyState icon={Target} title="No goals match “growth”" action={{ label: "Clear search", onClick: () => setQuery("") }}>Try another word, or clear the filter.</EmptyState>
  </ModuleHome>;
  return <main className="app-page gallery">
    <header className="gallery-header"><span className="brand-dot"><Sparkles /></span><h1>Workspace components</h1>
      <nav aria-label="Components"><a href="?c=module-home">Module home</a><a href="?c=presenter">Presenter</a><a href="?c=public">Public page</a><a href="?">All</a></nav>
      <button type="button" className="action-button secondary" onClick={() => setPresenting(true)}><CalendarClock aria-hidden="true" />Present</button>
    </header>
    <Samples only={only} />
    <p className="gallery-muted gallery-foot">Samples only; nothing here is saved.</p>
  </main>;
}
