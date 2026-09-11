import { test } from "node:test";
import assert from "node:assert/strict";
import {
  money,
  pct,
  signedMoney,
  signedNumber,
  compactNumber,
  pctChange,
  trendBadge,
  productLabel,
  MODEL_PRICING,
  modelPricingFor,
  compareRows,
  foldOther,
  isoToday,
  isoDaysAgo,
} from "../lib/format.mjs";

test("money: under $1000 shows two decimal places, no k suffix", () => {
  assert.equal(money(42.5), "$42.50");
  assert.equal(money(0), "$0.00");
});

test("money: $1000 and above compacts to a k suffix with one decimal place", () => {
  assert.equal(money(1500), "$1.5k");
  assert.equal(money(1000), "$1.0k");
});

test("money: negative amounts keep the sign in front of the $", () => {
  assert.equal(money(-42.5), "-$42.50");
  assert.equal(money(-1500), "-$1.5k");
});

test("pct: adds a leading + for zero/positive values, nothing for negative", () => {
  assert.equal(pct(5.34), "+5.3%");
  assert.equal(pct(0), "+0.0%");
  assert.equal(pct(-5.34), "-5.3%");
});

test("signedMoney: prefixes a + for zero/positive amounts, leaves money()'s own '-' for negative", () => {
  assert.equal(signedMoney(50), "+$50.00");
  assert.equal(signedMoney(0), "+$0.00");
  assert.equal(signedMoney(-30), "-$30.00");
});

test("signedNumber: rounds, adds thousands separators, and always shows a sign", () => {
  assert.equal(signedNumber(1234.6), "+1,235");
  assert.equal(signedNumber(-1234.6), "-1,235");
  assert.equal(signedNumber(0), "+0");
});

test("compactNumber: scales to M above 1e6 and k above 1e3, otherwise rounds to an integer", () => {
  assert.equal(compactNumber(2_500_000), "2.5M");
  assert.equal(compactNumber(2_500), "2.5k");
  assert.equal(compactNumber(42.6), "43");
  assert.equal(compactNumber(-2_500), "-2.5k");
});

test("pctChange: normal percentage change between two values", () => {
  assert.equal(pctChange(110, 100), 10);
  assert.equal(pctChange(90, 100), -10);
});

test("pctChange: a null/zero previous or null current returns null instead of NaN/Infinity", () => {
  assert.equal(pctChange(10, null), null);
  assert.equal(pctChange(10, 0), null);
  assert.equal(pctChange(null, 10), null);
});

test("trendBadge: null or non-finite diffValue renders nothing", () => {
  assert.equal(trendBadge(null), "");
  assert.equal(trendBadge(Infinity), "");
  assert.equal(trendBadge(NaN), "");
});

test("trendBadge: goodDirection flips which arrow direction is styled as good/bad", () => {
  assert.match(trendBadge(5, { goodDirection: "up" }), /trend-good/);
  assert.match(trendBadge(-5, { goodDirection: "up" }), /trend-bad/);
  assert.match(trendBadge(5, { goodDirection: "down" }), /trend-bad/);
  assert.match(trendBadge(-5, { goodDirection: "down" }), /trend-good/);
});

test("trendBadge: no goodDirection is neutral regardless of sign, and the arrow/value reflect direction/magnitude", () => {
  const up = trendBadge(5.4);
  assert.match(up, /trend-neutral/);
  assert.match(up, /▲/);
  assert.match(up, /5\.4%/);
  const down = trendBadge(-5.4);
  assert.match(down, /trend-neutral/);
  assert.match(down, /▼/);
  assert.match(down, /5\.4%/);
});

test("productLabel: known product codes map to their display label", () => {
  assert.equal(productLabel("chat"), "Chat");
  assert.equal(productLabel("claude_code"), "Claude Code");
  assert.equal(productLabel("claude-tag"), "Claude in Slack");
});

test("productLabel: an unknown code passes through unchanged", () => {
  assert.equal(productLabel("some_future_product"), "some_future_product");
});

test("modelPricingFor: looks up a known model directly", () => {
  assert.deepEqual(modelPricingFor("claude-sonnet-5"), MODEL_PRICING["claude-sonnet-5"]);
});

test("modelPricingFor: strips a trailing 8-digit snapshot date before matching", () => {
  assert.deepEqual(modelPricingFor("claude-haiku-4-5-20251001"), MODEL_PRICING["claude-haiku-4-5"]);
});

test("modelPricingFor: an unknown model returns null", () => {
  assert.equal(modelPricingFor("gpt-4o"), null);
});

test("compareRows: both values null are equal regardless of direction", () => {
  assert.equal(compareRows({ v: null }, { v: null }, "v", "asc"), 0);
  assert.equal(compareRows({ v: null }, { v: null }, "v", "desc"), 0);
});

test("compareRows: a null value always sorts after a non-null value, in either direction", () => {
  assert.equal(compareRows({ v: null }, { v: 5 }, "v", "asc"), 1);
  assert.equal(compareRows({ v: 5 }, { v: null }, "v", "asc"), -1);
  assert.equal(compareRows({ v: null }, { v: 5 }, "v", "desc"), 1);
  assert.equal(compareRows({ v: 5 }, { v: null }, "v", "desc"), -1);
});

test("compareRows: two non-null values sort ascending or descending by their numeric difference", () => {
  assert.equal(compareRows({ v: 5 }, { v: 10 }, "v", "asc"), -5);
  assert.equal(compareRows({ v: 5 }, { v: 10 }, "v", "desc"), 5);
});

test("foldOther: a series at or under cap+1 passes through unchanged, just tagged with colorIndex", () => {
  const series = [{ name: "a", spend: [1, 2], totalSpend: 3, requests: 1 }];
  const result = foldOther(series, 6);
  assert.equal(result.length, 1);
  assert.equal(result[0].colorIndex, 0);
  assert.equal(result[0].name, "a");
});

test("foldOther: a series over cap folds the tail into a summed 'Other' entry", () => {
  const series = Array.from({ length: 8 }, (_, i) => ({
    name: `s${i}`,
    spend: [i, i * 2],
    totalSpend: i * 3,
    requests: i,
  }));
  const result = foldOther(series, 6);
  assert.equal(result.length, 7);
  const other = result.at(-1);
  assert.equal(other.name, "Other");
  assert.equal(other.colorIndex, "other");
  // folded tail is series[6] and series[7]
  assert.equal(other.totalSpend, 6 * 3 + 7 * 3);
  assert.equal(other.requests, 6 + 7);
  assert.deepEqual(other.spend, [6 + 7, 12 + 14]);
});

test("isoToday/isoDaysAgo: both format as YYYY-MM-DD, and isoDaysAgo(0) matches today", () => {
  assert.match(isoToday(), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(isoDaysAgo(5), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(isoDaysAgo(0), isoToday());
});
