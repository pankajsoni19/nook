import { describe, expect, test } from "bun:test";
import { REPORT_INK, REPORT_SERIES } from "../shared/reportTheme";
import { HEALTH_LABEL, HEALTH_TONE, HEALTHS } from "../shared/tones";
import { insightOption, ratingBuckets, TONE_CHART } from "../src/ui/insights/Insights";

/** Audit 2 UI6/UI7 (D1181, D1182): insight charts follow the theme, keep status colours, and count in whole steps. */

type Pie = { color: string[]; series: Array<{ label: { color: string; textBorderWidth: number }; itemStyle: { borderColor: string } }> };
type Axis = { color: string[]; yAxis: { minInterval?: number; axisLabel: { color: string } }; xAxis: { axisLabel: { color: string } }; series: Array<{ data: Array<number | { value: number; itemStyle: { color: string } }> }> };

describe("insight chart theme (UI6)", () => {
  test("pie labels use the theme's ink with no halo, in both modes", () => {
    for (const mode of ["dark", "light"] as const) {
      const option = insightOption("pie", ["A", "B"], [{ name: "n", values: [1, 2] }], "number", { mode }) as unknown as Pie;
      expect(option.series[0]!.label.color).toBe(REPORT_INK[mode].inkSecondary);
      expect(option.series[0]!.label.textBorderWidth).toBe(0);
      expect(option.series[0]!.itemStyle.borderColor).toBe(REPORT_INK[mode].surface);
      expect(option.color).toEqual(REPORT_SERIES[mode].slice(0, 2));
    }
  });

  test("axis charts take the mode's palette and ink", () => {
    const light = insightOption("bar", ["A"], [{ name: "n", values: [1] }], "number", { mode: "light" }) as unknown as Axis;
    expect(light.color).toEqual([...REPORT_SERIES.light]);
    expect(light.yAxis.axisLabel.color).toBe(REPORT_INK.light.muted);
    expect(light.xAxis.axisLabel.color).toBe(REPORT_INK.light.muted);
    // The old call shape (a currency string) still works and defaults to dark.
    const money = insightOption("bar", ["A"], [{ name: "n", values: [1] }], "money", "EUR") as unknown as Axis;
    expect(money.color).toEqual([...REPORT_SERIES.dark]);
  });

  test("health slices are health colours, whatever order they arrive in", () => {
    const tones = Object.fromEntries(HEALTHS.map((health) => [HEALTH_LABEL[health], HEALTH_TONE[health]]));
    const categories = ["Off track", "On track", "At risk", "Something else"];
    for (const mode of ["dark", "light"] as const) {
      const option = insightOption("pie", categories, [{ name: "Goals", values: [1, 2, 3, 4] }], "number", { mode, tones }) as unknown as Pie;
      expect(option.color.slice(0, 3)).toEqual([TONE_CHART[mode].danger, TONE_CHART[mode].success, TONE_CHART[mode].warning]);
      expect(option.color[3]).toBe(REPORT_SERIES[mode][3]!);
    }
    const bars = insightOption("bar", ["On track"], [{ name: "Goals", values: [2] }], "number", { tones }) as unknown as Axis;
    expect(bars.series[0]!.data[0]).toEqual({ value: 2, itemStyle: { color: TONE_CHART.dark.success } });
  });
});

describe("insight chart counts (UI7)", () => {
  test("number charts tick in whole steps; durations, money and percents do not", () => {
    expect((insightOption("bar", ["A"], [{ name: "n", values: [1] }], "number") as unknown as Axis).yAxis.minInterval).toBe(1);
    for (const unit of ["duration", "money", "percent"] as const) expect((insightOption("bar", ["A"], [{ name: "n", values: [1] }], unit) as unknown as Axis).yAxis.minInterval).toBeUndefined();
  });

  test("rating buckets cover the whole scale, zeros included", () => {
    expect(ratingBuckets([{ value: 5, count: 3 }, { value: 2, count: 1 }], 1, 5)).toEqual([1, 2, 3, 4, 5].map((value) => ({ value, count: value === 5 ? 3 : value === 2 ? 1 : 0 })));
    // An answer outside an edited scale still shows, in order.
    expect(ratingBuckets([{ value: 7, count: 1 }], 1, 3).map((entry) => entry.value)).toEqual([1, 2, 3, 7]);
  });
});

describe("insight charts shrink with the window (D1263)", () => {
  test("the chart card and the insights column use tracks that may shrink below the drawn chart", async () => {
    const css = await Bun.file(new URL("../src/ui/workspace.css", import.meta.url)).text();
    expect(css).toContain(".ui-chart-card { grid-template-columns: minmax(0, 1fr); }");
    expect(css).toContain(".ui-insights { grid-template-columns: minmax(0, 1fr); }");
    expect(css).toMatch(/\.ui-chart-card \.report-chart-canvas \{ width: 100%; min-width: 0;/);
  });
});
