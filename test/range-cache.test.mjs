import { test } from "node:test";
import assert from "node:assert/strict";
import { readRangeCache, writeRangeCache, CACHE_PREFIX } from "../lib/range-cache.mjs";

function withStubbedSessionStorage(impl, run) {
  const original = globalThis.sessionStorage;
  globalThis.sessionStorage = impl;
  try {
    return run();
  } finally {
    globalThis.sessionStorage = original;
  }
}

function makeMemoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
}

test("readRangeCache: a cache miss returns undefined", () => {
  withStubbedSessionStorage(makeMemoryStorage(), () => {
    assert.equal(readRangeCache("cost-summary", "7"), undefined);
  });
});

test("writeRangeCache then readRangeCache: round-trips the exact data written", () => {
  withStubbedSessionStorage(makeMemoryStorage(), () => {
    const data = { totals: { spend: 12.5 }, labels: ["2026-01-01"] };
    writeRangeCache("cost-summary", "7", data);
    assert.deepEqual(readRangeCache("cost-summary", "7"), data);
  });
});

test("readRangeCache/writeRangeCache: keys are scoped by both endpoint and range key", () => {
  withStubbedSessionStorage(makeMemoryStorage(), () => {
    writeRangeCache("cost-summary", "7", { a: 1 });
    writeRangeCache("cost-summary", "28", { a: 2 });
    writeRangeCache("people", "7", { a: 3 });
    assert.deepEqual(readRangeCache("cost-summary", "7"), { a: 1 });
    assert.deepEqual(readRangeCache("cost-summary", "28"), { a: 2 });
    assert.deepEqual(readRangeCache("people", "7"), { a: 3 });
  });
});

test("writeRangeCache: namespaces keys under CACHE_PREFIX", () => {
  withStubbedSessionStorage(makeMemoryStorage(), () => {
    const storage = globalThis.sessionStorage;
    writeRangeCache("cost-summary", "7", { a: 1 });
    assert.equal(storage.getItem(`${CACHE_PREFIX}cost-summary:7`), JSON.stringify({ a: 1 }));
  });
});

test("readRangeCache: a storage that throws on getItem is treated as a cache miss, not an error", () => {
  withStubbedSessionStorage(
    {
      getItem: () => {
        throw new Error("sessionStorage unavailable");
      },
    },
    () => {
      assert.equal(readRangeCache("cost-summary", "7"), undefined);
    }
  );
});

test("writeRangeCache: a storage that throws on setItem fails silently rather than throwing", () => {
  withStubbedSessionStorage(
    {
      setItem: () => {
        throw new Error("quota exceeded");
      },
    },
    () => {
      assert.doesNotThrow(() => writeRangeCache("cost-summary", "7", { a: 1 }));
    }
  );
});
