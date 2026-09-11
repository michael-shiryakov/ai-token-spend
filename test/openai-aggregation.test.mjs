import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateOpenAiCostBuckets,
  aggregateOpenAiUsageBuckets,
  shapeActivitySummary,
} from "../server.mjs";

test("aggregateOpenAiCostBuckets: empty input yields zero total and an empty map", () => {
  const result = aggregateOpenAiCostBuckets([]);
  assert.equal(result.totalSpend, 0);
  assert.deepEqual([...result.dailyByDate.entries()], []);
});

test("aggregateOpenAiCostBuckets: sums decimal-USD amounts per date, using start_time_iso when present", () => {
  const buckets = [
    { start_time_iso: "2026-01-01T00:00:00Z", results: [{ amount: { value: 1.5 } }, { amount: { value: 2.5 } }] },
    { start_time_iso: "2026-01-02T00:00:00Z", results: [{ amount: { value: 1 } }] },
  ];
  const result = aggregateOpenAiCostBuckets(buckets);
  assert.equal(result.totalSpend, 5);
  assert.equal(result.dailyByDate.get("2026-01-01"), 4);
  assert.equal(result.dailyByDate.get("2026-01-02"), 1);
});

test("aggregateOpenAiCostBuckets: falls back to unix-seconds start_time when start_time_iso is absent", () => {
  const startTimeUnix = Date.parse("2026-03-15T00:00:00Z") / 1000;
  const buckets = [{ start_time: startTimeUnix, results: [{ amount: { value: 10 } }] }];
  const result = aggregateOpenAiCostBuckets(buckets);
  assert.equal(result.dailyByDate.get("2026-03-15"), 10);
});

test("aggregateOpenAiCostBuckets: a row missing amount.value defaults to 0 rather than throwing", () => {
  const buckets = [{ start_time_iso: "2026-01-01T00:00:00Z", results: [{}] }];
  const result = aggregateOpenAiCostBuckets(buckets);
  assert.equal(result.totalSpend, 0);
});

test("aggregateOpenAiUsageBuckets: empty input yields zero total requests and an empty map", () => {
  const result = aggregateOpenAiUsageBuckets([]);
  assert.equal(result.totalRequests, 0);
  assert.deepEqual([...result.dailyByDate.entries()], []);
});

test("aggregateOpenAiUsageBuckets: sums num_model_requests per date, using start_time_iso when present", () => {
  const buckets = [
    { start_time_iso: "2026-01-01T00:00:00Z", results: [{ num_model_requests: 3 }, { num_model_requests: 4 }] },
    { start_time_iso: "2026-01-02T00:00:00Z", results: [{ num_model_requests: 2 }] },
  ];
  const result = aggregateOpenAiUsageBuckets(buckets);
  assert.equal(result.totalRequests, 9);
  assert.equal(result.dailyByDate.get("2026-01-01"), 7);
  assert.equal(result.dailyByDate.get("2026-01-02"), 2);
});

test("aggregateOpenAiUsageBuckets: falls back to unix-seconds start_time when start_time_iso is absent", () => {
  const startTimeUnix = Date.parse("2026-03-15T00:00:00Z") / 1000;
  const buckets = [{ start_time: startTimeUnix, results: [{ num_model_requests: 5 }] }];
  const result = aggregateOpenAiUsageBuckets(buckets);
  assert.equal(result.dailyByDate.get("2026-03-15"), 5);
});

test("aggregateOpenAiUsageBuckets: a row missing num_model_requests defaults to 0 rather than throwing", () => {
  const buckets = [{ start_time_iso: "2026-01-01T00:00:00Z", results: [{}] }];
  const result = aggregateOpenAiUsageBuckets(buckets);
  assert.equal(result.totalRequests, 0);
});

test("shapeActivitySummary: maps every field from a full raw row", () => {
  const raw = {
    starting_at: "2026-01-01T00:00:00Z",
    assigned_seat_count: 50,
    pending_invite_count: 3,
    daily_active_user_count: 20,
    weekly_active_user_count: 35,
    monthly_active_user_count: 45,
    daily_adoption_rate: 0.4,
    weekly_adoption_rate: 0.7,
    monthly_adoption_rate: 0.9,
  };
  assert.deepEqual(shapeActivitySummary(raw), {
    date: "2026-01-01",
    assignedSeats: 50,
    pendingInvites: 3,
    dau: 20,
    wau: 35,
    mau: 45,
    dailyAdoptionRate: 0.4,
    weeklyAdoptionRate: 0.7,
    monthlyAdoptionRate: 0.9,
  });
});

test("shapeActivitySummary: every optional field missing falls back to null, and a missing starting_at yields a null date", () => {
  assert.deepEqual(shapeActivitySummary({}), {
    date: null,
    assignedSeats: null,
    pendingInvites: null,
    dau: null,
    wau: null,
    mau: null,
    dailyAdoptionRate: null,
    weeklyAdoptionRate: null,
    monthlyAdoptionRate: null,
  });
});
