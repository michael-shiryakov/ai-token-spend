import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reduceUsageRows,
  aggregateUsage,
  aggregateUsageGrouped,
  aggregateContextWindow,
  aggregateCostSeriesByDimension,
} from "../server.mjs";

test("reduceUsageRows: empty input yields zeroed totals and a null cache-hit-rate", () => {
  const result = reduceUsageRows([]);
  assert.deepEqual(result, {
    uncachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    totalInputTokens: 0,
    requests: 0,
    cacheHitRate: null,
  });
});

test("reduceUsageRows: sums token counts across rows and computes cache-hit-rate from cache-read share of total input", () => {
  const rows = [
    {
      uncached_input_tokens: 100,
      cache_read_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 50 },
      output_tokens: 20,
      requests: 2,
    },
    {
      uncached_input_tokens: 100,
      cache_read_input_tokens: 100,
      output_tokens: 10,
      requests: 1,
    },
  ];
  const result = reduceUsageRows(rows);
  assert.equal(result.uncachedInputTokens, 200);
  assert.equal(result.cacheReadInputTokens, 400);
  assert.equal(result.cacheCreationTokens, 100);
  assert.equal(result.outputTokens, 30);
  assert.equal(result.totalInputTokens, 700);
  assert.equal(result.requests, 3);
  assert.equal(result.cacheHitRate, 400 / 700);
});

test("reduceUsageRows: rows missing cache_creation entirely are treated as zero cache-creation tokens", () => {
  const result = reduceUsageRows([{ uncached_input_tokens: 10, requests: 1 }]);
  assert.equal(result.cacheCreationTokens, 0);
  assert.equal(result.totalInputTokens, 10);
  assert.equal(result.cacheHitRate, 0);
});

test("aggregateUsage: flattens buckets' results and delegates to reduceUsageRows", () => {
  const buckets = [
    { results: [{ uncached_input_tokens: 10, requests: 1 }] },
    { results: [{ uncached_input_tokens: 20, requests: 2 }] },
  ];
  const result = aggregateUsage(buckets);
  assert.equal(result.uncachedInputTokens, 30);
  assert.equal(result.requests, 3);
});

test("aggregateUsage: an empty buckets array behaves the same as reduceUsageRows([])", () => {
  assert.deepEqual(aggregateUsage([]), reduceUsageRows([]));
});

test("aggregateUsageGrouped: splits rows into one reduced total per distinct dimension value", () => {
  const buckets = [
    {
      results: [
        { model: "claude-3-opus", uncached_input_tokens: 100, requests: 1 },
        { model: "claude-3-haiku", uncached_input_tokens: 10, requests: 1 },
      ],
    },
    {
      results: [{ model: "claude-3-opus", uncached_input_tokens: 50, requests: 1 }],
    },
  ];
  const grouped = aggregateUsageGrouped(buckets, "model");
  assert.deepEqual([...grouped.keys()].sort(), ["claude-3-haiku", "claude-3-opus"]);
  assert.equal(grouped.get("claude-3-opus").uncachedInputTokens, 150);
  assert.equal(grouped.get("claude-3-opus").requests, 2);
  assert.equal(grouped.get("claude-3-haiku").uncachedInputTokens, 10);
});

test("aggregateUsageGrouped: rows missing the dimension key fall back to 'unspecified'", () => {
  const buckets = [{ results: [{ uncached_input_tokens: 5, requests: 1 }] }];
  const grouped = aggregateUsageGrouped(buckets, "model");
  assert.deepEqual([...grouped.keys()], ["unspecified"]);
  assert.equal(grouped.get("unspecified").uncachedInputTokens, 5);
});

test("aggregateContextWindow: empty input yields an empty array", () => {
  assert.deepEqual(aggregateContextWindow([]), []);
});

test("aggregateContextWindow: sums spend/requests per context_window, sorted by spend descending", () => {
  const buckets = [
    {
      results: [
        { context_window: "200k", amount: "100.00", requests: 1 },
        { context_window: "1m", amount: "300.00", requests: 2 },
      ],
    },
    {
      results: [{ context_window: "200k", amount: "50.00", requests: 1 }],
    },
  ];
  const result = aggregateContextWindow(buckets);
  assert.deepEqual(
    result.map((r) => r.name),
    ["1m", "200k"]
  );
  const window200k = result.find((r) => r.name === "200k");
  assert.equal(window200k.totalSpend, 1.5);
  assert.equal(window200k.requests, 2);
  assert.deepEqual(window200k.spend, [1, 0.5]);
});

test("aggregateContextWindow: rows missing context_window fall back to 'unspecified'", () => {
  const buckets = [{ results: [{ amount: "100.00", requests: 1 }] }];
  const result = aggregateContextWindow(buckets);
  assert.equal(result[0].name, "unspecified");
});

test("aggregateCostSeriesByDimension: empty input yields empty labels and series", () => {
  assert.deepEqual(aggregateCostSeriesByDimension([], "token_type"), { labels: [], series: [] });
});

test("aggregateCostSeriesByDimension: builds a per-key daily spend/requests series, sorted by total spend descending", () => {
  const buckets = [
    {
      starting_at: "2026-01-01T00:00:00Z",
      results: [
        { token_type: "input", amount: "100.00", list_amount: "100.00", requests: 1 },
        { token_type: "output", amount: "500.00", list_amount: "500.00", requests: 2 },
      ],
    },
    {
      starting_at: "2026-01-02T00:00:00Z",
      results: [{ token_type: "input", amount: "50.00", list_amount: "50.00", requests: 1 }],
    },
  ];
  const result = aggregateCostSeriesByDimension(buckets, "token_type");
  assert.deepEqual(result.labels, ["2026-01-01", "2026-01-02"]);
  assert.deepEqual(
    result.series.map((s) => s.key),
    ["output", "input"]
  );
  const input = result.series.find((s) => s.key === "input");
  assert.equal(input.totalSpend, 1.5);
  assert.equal(input.totalRequests, 2);
  assert.deepEqual(input.spend, [1, 0.5]);
  assert.deepEqual(input.requests, [1, 1]);
});

test("aggregateCostSeriesByDimension: rows missing the dimension key fall back to 'unspecified'", () => {
  const buckets = [
    { starting_at: "2026-01-01T00:00:00Z", results: [{ amount: "10.00", list_amount: "10.00", requests: 1 }] },
  ];
  const result = aggregateCostSeriesByDimension(buckets, "token_type");
  assert.equal(result.series[0].key, "unspecified");
});
