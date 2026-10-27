import assert from "node:assert/strict";
import test from "node:test";
import { clientName, providerFor, providerName, vendorFor } from "../src/vendors.ts";

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
  assert.equal(clientName("gemini"), "Gemini CLI");
  assert.equal(clientName("kimi"), "Kimi Code");
  assert.equal(clientName("stepfun"), "阶跃星辰");
  assert.equal(clientName("alibaba"), "阿里云百炼");
  assert.equal(clientName("fx"), "FX");
  assert.equal(clientName("mcode"), "MiniMax Code");
  assert.equal(clientName("droid"), "Factory Droid");
  assert.equal(clientName("kilo"), "Kilo Code");
  // v0.71–v0.74: Goose usage and Notion AI allowances.
  assert.equal(clientName("goose"), "Goose");
  assert.equal(providerName("notion"), "Notion AI");
  // v0.80: OmO Native usage and Muse Code allowances.
  assert.equal(clientName("senpi"), "OmO Native");
  assert.equal(providerName("muse"), "Muse Code");
});

test("all official limit providers resolve to formatted product names", () => {
  for (const [id, expected] of [
    ["claude", "Claude Code"],
    ["codex", "Codex"],
    ["opencode", "OpenCode"],
    ["cursor", "Cursor"],
    ["antigravity", "Antigravity"],
    ["cline", "Cline"],
    ["factory", "Factory Droid"],
    ["kimi", "Kimi"],
    ["grok", "Grok"],
    ["copilot", "GitHub Copilot"],
    ["zed", "Zed"],
    ["commandcode", "Command Code"],
    ["mimo", "Xiaomi MiMo"],
    ["muse", "Muse Code"],
    ["zai", "GLM"],
    ["zaiteam", "GLM Team"],
    ["kiro", "Kiro"],
    ["workbuddy", "WorkBuddy"],
    ["qoder", "Qoder"],
    ["deepseek", "DeepSeek"],
    ["devin", "Devin"],
    ["minimax", "MiniMax"],
    ["typesafe", "TypeSafe"],
    ["openrouter", "OpenRouter"],
    ["volcengine", "Volcengine"],
    ["ollama", "Ollama"],
    ["trae", "Trae"],
    ["alibaba", "Alibaba Cloud"],
    ["stepfun", "StepFun"],
    ["notion", "Notion AI"],
    ["thirdparty", "第三方接口"],
  ]) {
    assert.equal(providerName(id), expected, id);
  }
});
