import assert from "node:assert/strict";
import test from "node:test";
import { providerFor, providerName, vendorFor } from "../src/vendors.ts";

test("models the logo table recognises get the same vendor as their label", () => {
  for (const [model, label, logo] of [
    ["qwen-max", "Qwen", "qwen"],
    ["mistral-large", "Mistral", "mistral"],
    ["llama-3.1-70b", "Meta", "meta"],
    ["o3-mini", "OpenAI", "codex"],
    ["gemma-3-27b", "Google", "gemini"],
    ["minimax-m2", "MiniMax", "minimax"],
    ["command-r-plus", "Cohere", "cohere"],
    ["k2", "Kimi", "kimi"],
  ]) {
    assert.equal(providerName(providerFor(model)), label, model);
    assert.equal(vendorFor(model)?.logo, logo, model);
  }
});

test("unknown models are labelled in Chinese instead of the raw key", () => {
  assert.equal(providerFor("house-model-7"), "other");
  assert.equal(providerName("other"), "其他");
});

test("a local runner's name does not make a model Meta's", () => {
  assert.equal(providerFor("ollama"), "other");
  assert.equal(providerFor("ollama/qwen2.5"), "qwen");
  assert.equal(providerFor("ollama-llama3"), "meta");
});

test("service-reported client ids keep their product names", () => {
  assert.equal(providerName("droid"), "Factory Droid");
  assert.equal(providerName("stepfun"), "StepFun");
  assert.equal(providerName("mimo"), "Xiaomi MiMo");
});
