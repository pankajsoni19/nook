import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { datasetQueryText } from "../shared/reportsWorkspace";

const { textDataValues, workspaceTextErrors } = await import("../server/reports/specValidate");

/**
 * W3-REPORTS audit fix (D1068, T604): AI-written text on a This workspace report states no data values,
 * because text is the same for every reader while their numbers are their own (D1061).
 */

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Json };
}
const hoursByPerson = datasetQueryText({ dataset: "time.entries", measures: [{ fn: "sum", column: "hours", as: "hours" }], dimensions: ["person"] });

let owner: Session;
beforeAll(async () => {
  owner = await createUser("Workspace text owner");
  expect((await send(owner, "POST", "/time/entries", { startedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(), duration: "4h" })).status).toBeLessThan(300);
});

describe("text states no data values (D1068)", () => {
  test("numbers are data except years, time spans, and labels", () => {
    expect(textDataValues("Hours logged: 4 this month, up 12.5% on 1,240.")).toEqual(["4", "12.5", "1,240"]);
    expect(textDataValues("In 2026, the last 30 days and Q4 of FY26, 7d trend.")).toEqual([]);
    const spec = { blocks: [{ id: "intro", type: "markdown", markdown: "We logged 4 hours." }, { id: "other", type: "markdown", markdown: "Old 9 text." }], sections: [{ id: "s", title: "S", summary: "Total 3 deals" }] } as never;
    expect(workspaceTextErrors(spec, ["intro"]).length).toBe(2);
    expect(workspaceTextErrors(spec, ["intro"], [{ id: "s", title: "S", summary: "Total 3 deals" }])).toEqual([expect.stringContaining("block intro")]);
  });

  test("a generated workspace report whose markdown states a figure is refused; the agent rewrites it in words", async () => {
    const { startScriptedProvider } = await import("../scripts/fakeReportProvider");
    const { DEFAULT_COMPAT } = await import("../shared/agents");
    const { generateDeps, liveGenerations } = await import("../server/reports/generate");
    const submit = (markdown: string) => ({ toolCalls: [{ name: "submit_report", arguments: { title: "Hours by person", sections: [], parameters: [], queries: [{ key: "hours", sql: hoursByPerson, purpose: "Hours by person" }],
      blocks: [{ id: "intro", type: "markdown", markdown }, { id: "hours", type: "table", intent: "detail", title: "Hours by person", queryKey: "hours" }] } }] });
    const provider = startScriptedProvider(0, (context) => {
      if (context.step === 1) return { toolCalls: [{ name: "run_sql", arguments: { sql: hoursByPerson, purpose: "Hours by person", key: "hours" } }] };
      if (context.step === 2) return submit("The owner logged 4 hours this month.");
      return submit("Hours logged by each person this month, as your access allows.");
    });
    const original = generateDeps.connection;
    generateDeps.connection = () => ({ id: "scripted", baseUrl: provider.baseUrl, apiKey: null, model: "scripted-report-model", compat: DEFAULT_COMPAT });
    try {
      const noteId = (await send(owner, "POST", "/notes", { folderId: null })).body.note.id as string;
      expect((await send(owner, "PUT", `/notes/${noteId}/draft`, { markdown: "# Hours\n\nHours by person this month.", revision: 1 })).status).toBe(200);
      expect((await send(owner, "POST", `/notes/${noteId}/publish`)).status).toBe(200);
      const started = await send(owner, "POST", "/reports/generate", { docRef: noteId, serverId: "nook", datasourceId: "workspace" });
      expect(started.status).toBe(202);
      const until = Date.now() + 20_000;
      while (liveGenerations().length && Date.now() < until) await Bun.sleep(20);
      expect(db.query("SELECT status FROM report_runs WHERE id = ?").get(started.body.run.id)).toEqual({ status: "succeeded" });
      const system = String(provider.calls[0]!.messages?.[0]?.content ?? "");
      expect(system).toContain("state no figures from the data");
      expect(JSON.stringify(provider.calls[2]!.messages)).toContain("states data values");
      const spec = JSON.parse((db.query("SELECT spec_json FROM reports WHERE id = ?").get(started.body.report.id) as { spec_json: string }).spec_json);
      expect(spec.blocks.find((block: Json) => block.id === "intro").markdown).toBe("Hours logged by each person this month, as your access allows.");
    } finally {
      generateDeps.connection = original;
      provider.stop();
    }
  });
});
