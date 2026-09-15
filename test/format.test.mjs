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
  computeBaselineRange,
  computeSpendAboveRange,
  computeBlendedRate,
  computeExpectedListRate,
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

test("computeBaselineRange: fewer than 2 usable periods returns null", () => {
  assert.equal(computeBaselineRange([]), null);
  assert.equal(computeBaselineRange([100]), null);
  assert.equal(computeBaselineRange([null, undefined, NaN, 100]), null);
});

test("computeBaselineRange: computes mean, stddev and an expected range of mean +/- stddev", () => {
  const result = computeBaselineRange([100, 100, 100, 100]);
  assert.equal(result.mean, 100);
  assert.equal(result.stddev, 0);
  assert.equal(result.min, 100);
  assert.equal(result.max, 100);
  assert.deepEqual(result.expectedRange, [100, 100]);
  assert.equal(result.periodsUsed, 4);
});

test("computeBaselineRange: ignores null/NaN entries but still uses the rest", () => {
  const result = computeBaselineRange([100, null, 200, NaN]);
  assert.equal(result.periodsUsed, 2);
  assert.equal(result.mean, 150);
});

test("computeBaselineRange: expectedRange never goes below zero", () => {
  const result = computeBaselineRange([0, 0, 0, 100]);
  assert.equal(result.expectedRange[0], 0);
});

test("computeSpendAboveRange: spend inside or below the range is zero, not negative", () => {
  const range = computeBaselineRange([100, 100, 100, 100]);
  assert.deepEqual(computeSpendAboveRange(100, range), {
    amount: 0,
    percentage: 0,
    isAbove: false,
  });
  assert.deepEqual(computeSpendAboveRange(50, range), {
    amount: 0,
    percentage: 0,
    isAbove: false,
  });
});

test("computeSpendAboveRange: spend above the top of the range reports the overage amount and share of current spend", () => {
  const range = computeBaselineRange([100, 100, 100, 100]);
  const result = computeSpendAboveRange(150, range);
  assert.equal(result.amount, 50);
  assert.equal(result.isAbove, true);
  assert.ok(Math.abs(result.percentage - (50 / 150) * 100) < 1e-9);
});

test("computeSpendAboveRange: null baseline or current spend returns null", () => {
  assert.equal(computeSpendAboveRange(100, null), null);
  assert.equal(computeSpendAboveRange(null, computeBaselineRange([1, 2])), null);
});

test("computeBlendedRate: splits cost by token type and blends across all three", () => {
  const usage = {
    uncachedInputTokens: 500_000,
    cacheReadInputTokens: 500_000,
    cacheCreationTokens: 0,
    outputTokens: 1_000_000,
  };
  const tokenCosts = new Map([
    ["uncached_input_tokens", 1],
    ["cache_read_input_tokens", 0.1],
    ["output_tokens", 10],
  ]);
  const result = computeBlendedRate(usage, tokenCosts);
  assert.equal(result.totalSpend, 11.1);
  assert.equal(result.ratePerMillion, (11.1 / 2_000_000) * 1_000_000);
  const byType = Object.fromEntries(
    result.byTokenType.map((t) => [t.type, t]),
  );
  assert.equal(byType.input.ratePerMillion, 2);
  assert.equal(byType.cached.ratePerMillion, 0.2);
  assert.equal(byType.output.ratePerMillion, 10);
});

test("computeBlendedRate: folds cache-creation writes into the input bucket", () => {
  const usage = {
    uncachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationTokens: 1_000_000,
    outputTokens: 0,
  };
  const tokenCosts = new Map([
    ["cache_creation.ephemeral_5m_input_tokens", 3],
    ["cache_creation.ephemeral_1h_input_tokens", 2],
  ]);
  const result = computeBlendedRate(usage, tokenCosts);
  const input = result.byTokenType.find((t) => t.type === "input");
  assert.equal(input.spend, 5);
  assert.equal(input.tokens, 1_000_000);
});

test("computeBlendedRate: a token type with zero tokens reports a null rate instead of NaN/Infinity", () => {
  const usage = {
    uncachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
  };
  const result = computeBlendedRate(usage, new Map());
  assert.equal(result.ratePerMillion, null);
  for (const t of result.byTokenType) assert.equal(t.ratePerMillion, null);
});

test("computeExpectedListRate: weights list price by each model's own token mix", () => {
  const usageByModel = new Map([
    [
      "claude-sonnet-5",
      {
        uncachedInputTokens: 1_000_000,
        cacheReadInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 1_000_000,
      },
    ],
    [
      "claude-haiku-4-5",
      {
        uncachedInputTokens: 1_000_000,
        cacheReadInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
      },
    ],
  ]);
  const pricing = { "claude-sonnet-5": { input: 2, cached: 0.2, output: 10 } };
  const result = computeExpectedListRate(
    usageByModel,
    (model) => pricing[model] ?? null,
  );
  // sonnet: $2 input + $10 output = $12; haiku is skipped (no pricing entry)
  assert.equal(result.totalSpend, 12);
  assert.equal(result.modelsSkipped, 1);
});

test("computeExpectedListRate: empty usage returns zero spend and a null rate, not NaN", () => {
  const result = computeExpectedListRate(new Map(), () => null);
  assert.equal(result.totalSpend, 0);
  assert.equal(result.ratePerMillion, null);
  assert.equal(result.modelsSkipped, 0);
});
