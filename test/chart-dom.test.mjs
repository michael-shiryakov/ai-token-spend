import { test } from "node:test";
import assert from "node:assert/strict";
import { xScale, yScale, niceMax } from "../lib/chart-dom.mjs";

test("xScale: spreads indices evenly across the plot width", () => {
  const scale = xScale(5, 100, 10);
  assert.equal(scale(0), 10);
  assert.equal(scale(4), 110);
  assert.equal(scale(2), 60);
});

test("xScale: a single label centers instead of dividing by zero", () => {
  const scale = xScale(1, 100, 10);
  assert.equal(scale(0), 60);
});

test("yScale: maps 0 to the bottom of the plot and max to the top (inverted)", () => {
  const scale = yScale(200, 100, 10);
  assert.equal(scale(0), 110);
  assert.equal(scale(200), 10);
  assert.equal(scale(100), 60);
});

test("niceMax: adds 15% headroom then rounds up to the next multiple of its own order of magnitude", () => {
  assert.equal(niceMax(42), 50);
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(87), 110);
});

test("niceMax: applies the same rule at larger magnitudes", () => {
  assert.equal(niceMax(1000), 2000);
  assert.equal(niceMax(4321), 5000);
});
