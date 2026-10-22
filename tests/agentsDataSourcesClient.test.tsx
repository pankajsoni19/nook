import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DataSourcesToolGroup } from "../src/chat/AgentsSettings";
import { resultCsv, SqlResults } from "../src/chat/SqlResultCard";
import { callLabel } from "../src/chat/ToolDisclosure";
import { orphanRefs, pickCounts, refKey, refName, toggleRef } from "../src/chat/toolPicker";
import type { AgentToolRef, ToolCallView, ToolCatalog } from "../shared/agents";
import { agentUseAllows } from "../shared/reports";

/**
 * Lane AGENTSQL (D590–D598), the client: the agent editor's Data sources group, the picker's model for
 * data source picks, a run_sql call's label and its result table, and CSV export (formula cells quoted).
 */
const source = { id: "11111111-1111-4111-8111-111111111111", name: "Warehouse", database: "analytics", tables: 12 };
const ref: AgentToolRef = { source: "datasource", datasourceId: source.id };

describe("the policy words (D590)", () => {
  test("off nobody; admins; members and admins; never viewers or guests", () => {
    expect(["admin", "member", "viewer", "guest"].map((role) => agentUseAllows("off", role))).toEqual([false, false, false, false]);
    expect(["admin", "member", "viewer", "guest"].map((role) => agentUseAllows("admins", role))).toEqual([true, false, false, false]);
    expect(["admin", "member", "viewer", "guest"].map((role) => agentUseAllows("members", role))).toEqual([true, true, false, false]);
  });
});

describe("the agent editor's Data sources group (D591)", () => {
  test("lists the open data sources with a checkbox each, or says how an admin opens one", () => {
    const markup = renderToStaticMarkup(<DataSourcesToolGroup sources={[source]} tools={[ref]} onChange={() => {}} />);
    expect(markup).toContain("Data sources");
    expect(markup).toContain("1 picked");
    expect(markup).toContain("Warehouse");
    expect(markup).toContain("12 tables allowed");
    expect(markup).toContain("checked");
    const empty = renderToStaticMarkup(<DataSourcesToolGroup sources={[]} tools={[]} onChange={() => {}} />);
    expect(empty).toContain("Settings → Report data sources");
  });

  test("the picker's model: keys, toggling, counts, and a pick an admin closed is an orphan", () => {
    expect(refKey(ref)).toBe(`datasource:${source.id}`);
    expect(refName(ref)).toBe("A data source");
    expect(toggleRef([ref], ref)).toEqual([]);
    const catalog: ToolCatalog = { servers: [], nook: { linked: false, linkState: "none", tools: [] }, datasources: [] };
    expect(pickCounts([ref], catalog).datasources).toBe(1);
    expect(orphanRefs([ref], catalog)).toEqual([ref]);
    expect(orphanRefs([ref], { ...catalog, datasources: [source] })).toEqual([]);
    // An older server sends no list: its picks are left alone.
    expect(orphanRefs([ref], { servers: [], nook: { linked: false, linkState: "none", tools: [] } })).toEqual([]);
  });
});

describe("a run_sql result in the chat (D594)", () => {
  const call: ToolCallView = { id: "c1", tool: "run_sql", server: "data", serverId: null, argsPreview: "{}", resultPreview: "3 rows", ok: true, truncated: false, durationMs: 10, decision: null, proposalId: null,
    sqlResult: { id: "22222222-2222-4222-8222-222222222222", datasourceId: source.id, datasourceName: "Warehouse", rowCount: 1000, columnCount: 2, truncated: true } };

  test("the call reads by what it did, and the table card says rows truncated", () => {
    expect(callLabel(call)).toBe("Ran a query");
    expect(callLabel({ ...call, tool: "search_schema" })).toBe("Searched the schema");
    const markup = renderToStaticMarkup(<SqlResults calls={[call]} chatId="33333333-3333-4333-8333-333333333333" canMakeReport onTurnIntoReport={() => {}} />);
    expect(markup).toContain("Warehouse");
    expect(markup).toContain("1,000 rows · rows truncated");
    expect(markup).toContain("Loading the result");
    // Outside a chat (the public page) nothing is shown.
    expect(renderToStaticMarkup(<SqlResults calls={[call]} chatId={undefined} canMakeReport={false} />)).toBe("");
  });

  test("CSV: a header row, quoting, and formula cells defused", () => {
    expect(resultCsv({ columns: [{ name: "country", type: "String" }, { name: "n", type: "UInt64" }], rows: [["DE", 3], ["a,b", null], ["=1+1", "say \"hi\""]] }))
      .toBe("country,n\r\nDE,3\r\n\"a,b\",\r\n'=1+1,\"say \"\"hi\"\"\"");
  });
});
