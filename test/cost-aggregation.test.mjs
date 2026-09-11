import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateCostBuckets,
  emptyDailyBuckets,
  toDollars,
  computeCachingSavings,
  parseOpenAiLineItem,
} from "../server.mjs";

test("toDollars: converts a cents-as-decimal-string amount to dollars", () => {
  assert.equal(toDollars("41280.000000"), 412.8);
  assert.equal(toDollars("0.00"), 0);
});

test("toDollars: a non-numeric string yields NaN rather than throwing", () => {
  assert.ok(Number.isNaN(toDollars("abc")));
});

test("toDollars: a negative amount converts to negative dollars", () => {
  assert.equal(toDollars("-500.00"), -5);
});

test("emptyDailyBuckets: one zero-value bucket per whole day in the range, correctly dated", () => {
  const buckets = emptyDailyBuckets("2026-01-01T00:00:00.000Z", "2026-01-04T00:00:00.000Z");
  assert.equal(buckets.length, 3);
  assert.deepEqual(
    buckets.map((b) => b.starting_at),
    ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"]
  );
  for (const b of buckets) assert.deepEqual(b.results, []);
});

test("emptyDailyBuckets: a zero-length range produces no buckets", () => {
  assert.deepEqual(emptyDailyBuckets("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"), []);
});

test("aggregateCostBuckets: empty input yields zeroed totals and empty series", () => {
  const result = aggregateCostBuckets([]);
  assert.deepEqual(result.labels, []);
  assert.deepEqual(result.daily, []);
  assert.deepEqual(result.byProduct, []);
  assert.deepEqual(result.byModel, []);
  assert.deepEqual(result.totals, { spend: 0, listAmount: 0, requests: 0 });
});

test("aggregateCostBuckets: a single bucket/row totals correctly and appears in both series", () => {
  const buckets = [
    {
      starting_at: "2026-01-01T00:00:00Z",
      results: [{ product: "api", model: "claude-3", amount: "1000.00", list_amount: "1200.00", requests: 5 }],
    },
  ];
  const result = aggregateCostBuckets(buckets);
  assert.deepEqual(result.labels, ["2026-01-01"]);
  assert.deepEqual(result.daily, [{ date: "2026-01-01", spend: 10, listAmount: 12, requests: 5 }]);
  assert.deepEqual(result.totals, { spend: 10, listAmount: 12, requests: 5 });
  assert.equal(result.byProduct.length, 1);
  assert.equal(result.byProduct[0].name, "api");
  assert.deepEqual(result.byProduct[0].spend, [10]);
  assert.equal(result.byProduct[0].totalSpend, 10);
  assert.equal(result.byModel[0].name, "claude-3");
});

test("aggregateCostBuckets: sums across multiple days per-product/per-model, sorted by spend descending", () => {
  const buckets = [
    {
      starting_at: "2026-01-01T00:00:00Z",
      results: [
        { product: "api", model: "claude-3-opus", amount: "500.00", list_amount: "600.00", requests: 2 },
        { product: "chat", model: "claude-3-haiku", amount: "300.00", list_amount: "300.00", requests: 1 },
      ],
    },
    {
      starting_at: "2026-01-02T00:00:00Z",
      results: [
        { product: "api", model: "claude-3-opus", amount: "700.00", list_amount: "800.00", requests: 3 },
        { product: "chat", model: "claude-3-haiku", amount: "100.00", list_amount: "100.00", requests: 1 },
      ],
    },
  ];
  const result = aggregateCostBuckets(buckets);

  assert.deepEqual(result.totals, { spend: 16, listAmount: 18, requests: 7 });
  assert.deepEqual(result.daily, [
    { date: "2026-01-01", spend: 8, listAmount: 9, requests: 3 },
    { date: "2026-01-02", spend: 8, listAmount: 9, requests: 4 },
  ]);

  // api (totalSpend 12) outranks chat (totalSpend 4) — byProduct/byModel are sorted descending.
  assert.deepEqual(
    result.byProduct.map((p) => p.name),
    ["api", "chat"]
  );
  const api = result.byProduct[0];
  assert.equal(api.totalSpend, 12);
  assert.equal(api.totalListAmount, 14);
  assert.equal(api.requests, 5);
  assert.deepEqual(api.spend, [5, 7]);
  assert.deepEqual(api.requestsDaily, [2, 3]);

  assert.deepEqual(
    result.byModel.map((m) => m.name),
    ["claude-3-opus", "claude-3-haiku"]
  );
});

test("aggregateCostBuckets: rows without product/model still count toward totals but not the breakdowns", () => {
  const buckets = [
    { starting_at: "2026-01-01T00:00:00Z", results: [{ amount: "200.00", list_amount: "200.00", requests: 1 }] },
  ];
  const result = aggregateCostBuckets(buckets);
  assert.deepEqual(result.totals, { spend: 2, listAmount: 2, requests: 1 });
  assert.deepEqual(result.byProduct, []);
  assert.deepEqual(result.byModel, []);
});

test("aggregateCostBuckets: a row missing amount/list_amount still counts requests but poisons spend with NaN", () => {
  const buckets = [
    {
      starting_at: "2026-01-01T00:00:00Z",
      results: [{ product: "api", model: "claude-3", requests: 4 }],
    },
  ];
  const result = aggregateCostBuckets(buckets);
  assert.ok(Number.isNaN(result.totals.spend));
  assert.ok(Number.isNaN(result.totals.listAmount));
  assert.equal(result.totals.requests, 4);
});

test("aggregateCostBuckets: requests defaults to 0 when absent, distinct from an explicit 0", () => {
  const buckets = [
    {
      starting_at: "2026-01-01T00:00:00Z",
      results: [{ product: "api", model: "claude-3", amount: "100.00", list_amount: "100.00" }],
    },
  ];
  const result = aggregateCostBuckets(buckets);
  assert.equal(result.totals.requests, 0);
  assert.equal(result.byProduct[0].requests, 0);
});

test("aggregateCostBuckets: duplicate product/model pairs within the same bucket are summed, not overwritten", () => {
  const buckets = [
    {
      starting_at: "2026-01-01T00:00:00Z",
      results: [
        { product: "api", model: "claude-3", amount: "100.00", list_amount: "100.00", requests: 1 },
        { product: "api", model: "claude-3", amount: "200.00", list_amount: "200.00", requests: 2 },
      ],
    },
  ];
  const result = aggregateCostBuckets(buckets);
  assert.equal(result.byProduct.length, 1);
  assert.equal(result.byProduct[0].totalSpend, 3);
  assert.equal(result.byProduct[0].requests, 3);
  assert.equal(result.byModel.length, 1);
  assert.equal(result.byModel[0].totalSpend, 3);
});

test("computeCachingSavings: missing keys in tokenCosts default to 0 rather than throwing", () => {
  const usage = { uncachedInputTokens: 1000, totalInputTokens: 2000 };
  const result = computeCachingSavings(usage, new Map());
  assert.equal(result.actualInputCost, 0);
  assert.equal(result.hypotheticalInputCost, 0);
  assert.equal(result.cachingSavings, 0);
});

test("computeCachingSavings: computes savings from the blended uncached rate", () => {
  const usage = { uncachedInputTokens: 1000, totalInputTokens: 5000 };
  const tokenCosts = new Map([
    ["uncached_input_tokens", 10],
    ["cache_read_input_tokens", 2],
    ["cache_creation.ephemeral_5m_input_tokens", 1],
    ["cache_creation.ephemeral_1h_input_tokens", 0.5],
  ]);
  const result = computeCachingSavings(usage, tokenCosts);
  assert.equal(result.actualInputCost, 13.5);
  assert.equal(result.hypotheticalInputCost, 50);
  assert.equal(result.cachingSavings, 36.5);
});

test("computeCachingSavings: no uncached tokens means no blended rate, so savings is null rather than a divide-by-zero", () => {
  const usage = { uncachedInputTokens: 0, totalInputTokens: 5000 };
  const tokenCosts = new Map([["cache_read_input_tokens", 2]]);
  const result = computeCachingSavings(usage, tokenCosts);
  assert.equal(result.actualInputCost, 2);
  assert.equal(result.hypotheticalInputCost, null);
  assert.equal(result.cachingSavings, null);
});

test("parseOpenAiLineItem: plain model + token type", () => {
  assert.deepEqual(parseOpenAiLineItem("gpt-4o-mini-2024-07-18, cached input"), {
    model: "gpt-4o-mini-2024-07-18",
    tokenType: "cached input",
    priority: false,
    longContext: false,
  });
});

test("parseOpenAiLineItem: a 'priority | ' prefix sets priority: true", () => {
  assert.deepEqual(parseOpenAiLineItem("priority | gpt-5.6-sol, output"), {
    model: "gpt-5.6-sol",
    tokenType: "output",
    priority: true,
    longContext: false,
  });
});

test("parseOpenAiLineItem: a ', long context' suffix sets longContext: true", () => {
  assert.deepEqual(parseOpenAiLineItem("gpt-4o, input, long context"), {
    model: "gpt-4o",
    tokenType: "input",
    priority: false,
    longContext: true,
  });
});

test("parseOpenAiLineItem: priority and long context combine independently", () => {
  assert.deepEqual(parseOpenAiLineItem("priority | gpt-4o, output, long context"), {
    model: "gpt-4o",
    tokenType: "output",
    priority: true,
    longContext: true,
  });
});

test("parseOpenAiLineItem: a non-matching string (e.g. a tool cost) falls back to the 'Other (tools)' shape", () => {
  assert.deepEqual(parseOpenAiLineItem("web search tool calls"), {
    model: "Other (tools)",
    tokenType: "other",
    priority: false,
    longContext: false,
  });
});

test("parseOpenAiLineItem: a string with no comma separator falls back to the 'Other (tools)' shape", () => {
  assert.deepEqual(parseOpenAiLineItem("gpt-4o input"), {
    model: "Other (tools)",
    tokenType: "other",
    priority: false,
    longContext: false,
  });
});

test("parseOpenAiLineItem: an empty string falls back to the 'Other (tools)' shape", () => {
  assert.deepEqual(parseOpenAiLineItem(""), {
    model: "Other (tools)",
    tokenType: "other",
    priority: false,
    longContext: false,
  });
});
