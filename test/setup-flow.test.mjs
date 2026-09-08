import { test } from "node:test";
import assert from "node:assert/strict";
import { setupPageCopy, resolveKeysToPersist, verifyKey } from "../server.mjs";

test("setupPageCopy: 'setup' mode (first run, neither provider configured) shows both cards", () => {
  const copy = setupPageCopy("setup");
  assert.deepEqual(copy.cards, ["anthropic", "openai"]);
  assert.equal(copy.buttonLabel, "Open dashboard");
});

test("setupPageCopy: 'add-openai' shows only the OpenAI card and never mentions adoption", () => {
  const copy = setupPageCopy("add-openai");
  assert.deepEqual(copy.cards, ["openai"]);
  assert.equal(copy.buttonLabel, "Add OpenAI");
  // Adoption/seat data is Anthropic-only (see available-data-points.md) — connecting OpenAI
  // can never unlock it, so this copy must not imply otherwise.
  assert.doesNotMatch(copy.title + " " + copy.subtitle, /adoption/i);
});

test("setupPageCopy: 'add-anthropic' shows only the Anthropic card and does mention adoption", () => {
  const copy = setupPageCopy("add-anthropic");
  assert.deepEqual(copy.cards, ["anthropic"]);
  assert.equal(copy.buttonLabel, "Add Anthropic");
  // Connecting Anthropic genuinely does unlock Claude adoption tracking, so this copy is
  // allowed — and expected — to say so.
  assert.match(copy.title + " " + copy.subtitle, /adoption/i);
});

// Regression coverage for the silent .env-overwrite bug fixed earlier: adding one provider
// to an already-configured install must never drop the other, already-working key.
test("resolveKeysToPersist: first run, both keys submitted, are both persisted", () => {
  const result = resolveKeysToPersist({
    anthropicKey: "sk-ant-new",
    openaiKey: "sk-openai-new",
    anthropicEnabled: false,
    openaiEnabled: false,
    existingAnthropicKey: undefined,
    existingOpenaiKey: undefined,
  });
  assert.deepEqual(result, { finalAnthropicKey: "sk-ant-new", finalOpenaiKey: "sk-openai-new" });
});

test("resolveKeysToPersist: first run, only one key submitted, the other stays empty (not undefined)", () => {
  const result = resolveKeysToPersist({
    anthropicKey: "sk-ant-new",
    openaiKey: "",
    anthropicEnabled: false,
    openaiEnabled: false,
    existingAnthropicKey: undefined,
    existingOpenaiKey: undefined,
  });
  assert.deepEqual(result, { finalAnthropicKey: "sk-ant-new", finalOpenaiKey: "" });
});

test("resolveKeysToPersist: adding OpenAI to an Anthropic-only install keeps the existing Anthropic key", () => {
  const result = resolveKeysToPersist({
    anthropicKey: "",
    openaiKey: "sk-openai-new",
    anthropicEnabled: true,
    openaiEnabled: false,
    existingAnthropicKey: "sk-ant-existing",
    existingOpenaiKey: undefined,
  });
  assert.deepEqual(result, { finalAnthropicKey: "sk-ant-existing", finalOpenaiKey: "sk-openai-new" });
});

test("resolveKeysToPersist: adding Anthropic to an OpenAI-only install keeps the existing OpenAI key", () => {
  const result = resolveKeysToPersist({
    anthropicKey: "sk-ant-new",
    openaiKey: "",
    anthropicEnabled: false,
    openaiEnabled: true,
    existingAnthropicKey: undefined,
    existingOpenaiKey: "sk-openai-existing",
  });
  assert.deepEqual(result, { finalAnthropicKey: "sk-ant-new", finalOpenaiKey: "sk-openai-existing" });
});

function withStubbedFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = original;
  });
}

test("verifyKey: a 401 response is classified as a rejected key", async () => {
  await withStubbedFetch(
    async () => ({ status: 401 }),
    async () => {
      const message = await verifyKey("Anthropic", "https://example.test", {}, "permission denied");
      assert.match(message, /rejected/);
    }
  );
});

test("verifyKey: a 403 response passes through the provider-specific permission error unchanged", async () => {
  await withStubbedFetch(
    async () => ({ status: 403 }),
    async () => {
      const message = await verifyKey("OpenAI", "https://example.test", {}, "generate an Admin API key");
      assert.equal(message, "generate an Admin API key");
    }
  );
});

test("verifyKey: a network failure does not block saving (returns null, not an error)", async () => {
  await withStubbedFetch(
    async () => {
      throw new Error("network down");
    },
    async () => {
      const message = await verifyKey("Anthropic", "https://example.test", {}, "permission denied");
      assert.equal(message, null);
    }
  );
});

test("verifyKey: a 200 response means the key is valid (returns null)", async () => {
  await withStubbedFetch(
    async () => ({ status: 200 }),
    async () => {
      const message = await verifyKey("Anthropic", "https://example.test", {}, "permission denied");
      assert.equal(message, null);
    }
  );
});
