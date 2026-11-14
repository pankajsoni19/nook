import { expect, test } from "bun:test";
import { formatMoney, isCurrency, minorDigits, moneyForSeconds, parseMoney, sumMoney } from "../shared/money";

/** shared/money.ts (docs/plan/WORKSPACE_MODULES.md §B.16): integer minor units, never converted. */

test("currencies and minor units", () => {
  expect(isCurrency("USD")).toBe(true);
  expect(isCurrency("usd")).toBe(false);
  expect(isCurrency("XYZQ")).toBe(false);
  expect(minorDigits("JPY")).toBe(0);
  expect(minorDigits("KWD")).toBe(3);
  expect(minorDigits("EUR")).toBe(2);
});

test("parses typed amounts into minor units", () => {
  expect(parseMoney("1,234.50", "USD")).toBe(123450);
  expect(parseMoney("$12", "USD")).toBe(1200);
  expect(parseMoney("12.345", "USD")).toBeNull();
  expect(parseMoney("12.345", "KWD")).toBe(12345);
  expect(parseMoney("1500", "JPY")).toBe(1500);
  expect(parseMoney("-3.5", "EUR")).toBe(-350);
  expect(parseMoney("abc", "EUR")).toBeNull();
});

test("formats, sums one currency only, and prices time", () => {
  expect(formatMoney({ amount: 123450, currency: "USD" }, "en-US")).toBe("$1,234.50");
  expect(formatMoney({ amount: 1500, currency: "JPY" }, "en-US")).toBe("¥1,500");
  expect(sumMoney([{ amount: 100, currency: "EUR" }, { amount: 250, currency: "EUR" }])).toEqual({ amount: 350, currency: "EUR" });
  expect(sumMoney([{ amount: 100, currency: "EUR" }, { amount: 250, currency: "USD" }])).toBeNull();
  expect(sumMoney([])).toBeNull();
  expect(moneyForSeconds(10_000, 5400)).toBe(15_000);
});
