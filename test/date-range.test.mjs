import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkDateRange, resolveRange, rangeDays } from "../server.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

test("chunkDateRange: range under 31 days returns a single chunk covering the whole span", () => {
  const start = "2026-01-01T00:00:00.000Z";
  const end = "2026-01-08T00:00:00.000Z"; // 7 days
  const chunks = chunkDateRange(start, end);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0][0], start);
  assert.equal(chunks[0][1], end);
});

test("chunkDateRange: exactly 31 days returns a single chunk", () => {
  const start = "2026-01-01T00:00:00.000Z";
  const end = new Date(new Date(start).getTime() + 31 * DAY_MS).toISOString();
  const chunks = chunkDateRange(start, end);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0][0], start);
  assert.equal(chunks[0][1], end);
});

test("chunkDateRange: 32 days splits into two contiguous chunks", () => {
  const start = "2026-01-01T00:00:00.000Z";
  const end = new Date(new Date(start).getTime() + 32 * DAY_MS).toISOString();
  const chunks = chunkDateRange(start, end);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0][0], start);
  assert.equal(chunks[0][1], chunks[1][0], "chunks must be contiguous with no gap or overlap");
  assert.equal(chunks[1][1], end);
});

for (const days of [90, 180, 365]) {
  test(`chunkDateRange: a ${days}-day range produces the correct number of contiguous chunks`, () => {
    const start = "2026-01-01T00:00:00.000Z";
    const end = new Date(new Date(start).getTime() + days * DAY_MS).toISOString();
    const chunks = chunkDateRange(start, end);
    assert.equal(chunks.length, Math.ceil(days / 31));
    assert.equal(chunks[0][0], start, "first chunk starts at the range start");
    assert.equal(chunks.at(-1)[1], end, "last chunk ends at the range end");
    for (let i = 0; i < chunks.length - 1; i++) {
      assert.equal(chunks[i][1], chunks[i + 1][0], `chunk ${i} and ${i + 1} must be contiguous`);
    }
  });
}

test("rangeDays: an allowed preset passes through unchanged", () => {
  assert.equal(rangeDays(new URLSearchParams("days=28")), 28);
  assert.equal(rangeDays(new URLSearchParams("days=180")), 180);
});

test("rangeDays: a missing or disallowed value falls back to 7", () => {
  assert.equal(rangeDays(new URLSearchParams("")), 7);
  assert.equal(rangeDays(new URLSearchParams("days=999")), 7);
});

test("resolveRange: a preset days param resolves to that many days ending near now", () => {
  const before = Date.now();
  const range = resolveRange(new URLSearchParams("days=7"));
  const after = Date.now();
  assert.equal(range.days, 7);
  assert.equal(new Date(range.endingAt).getTime() - new Date(range.startingAt).getTime(), 7 * DAY_MS);
  const endingAtMs = new Date(range.endingAt).getTime();
  assert.ok(endingAtMs >= before && endingAtMs <= after, "endingAt should be resolved from the current time");
});

test("resolveRange: the previous period immediately precedes the current one with no gap", () => {
  const range = resolveRange(new URLSearchParams("days=28"));
  assert.equal(range.prevEndingAt, range.startingAt);
  assert.equal(new Date(range.startingAt).getTime() - new Date(range.prevStartingAt).getTime(), 28 * DAY_MS);
});

test("resolveRange: a valid custom from/to range in the past is honored exactly", () => {
  const range = resolveRange(new URLSearchParams("from=2026-01-01&to=2026-01-10"));
  assert.equal(range.startingAt, "2026-01-01T00:00:00.000Z");
  // `to` is inclusive, so a day is added internally to cover the whole `to` date.
  assert.equal(range.endingAt, "2026-01-11T00:00:00.000Z");
  assert.equal(range.days, 10);
});

test("resolveRange: a malformed custom date falls back to the 7-day preset default", () => {
  const range = resolveRange(new URLSearchParams("from=not-a-date&to=2026-01-10"));
  assert.equal(range.days, 7);
});

test("resolveRange: from after to falls back to the preset default instead of a negative range", () => {
  const range = resolveRange(new URLSearchParams("from=2026-01-10&to=2026-01-01"));
  assert.equal(range.days, 7);
  assert.ok(new Date(range.endingAt).getTime() > new Date(range.startingAt).getTime());
});
