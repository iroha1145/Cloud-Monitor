/**
 * Which company a model name belongs to. One table gives both the provider
 * label under a model and the logo next to it, so the two cannot disagree.
 * Order matters: the first matching pattern wins.
 */
export const VENDORS = [
  { id: "anthropic", name: "Anthropic", logo: "claude", pattern: /claude|anthropic|sonnet|opus|haiku/ },
  { id: "openai", name: "OpenAI", logo: "codex", pattern: /gpt|openai|chatgpt|codex|(?:^|[^a-z])o[1-9](?:[-.]|$)/ },
  { id: "google", name: "Google", logo: "gemini", pattern: /gemini|gemma|google/ },
  { id: "xai", name: "xAI", logo: "grok", pattern: /grok|xai/ },
  { id: "deepseek", name: "DeepSeek", logo: "deepseek", pattern: /deepseek/ },
  { id: "qwen", name: "Qwen", logo: "qwen", pattern: /qwen|qwq/ },
  { id: "glm", name: "GLM", logo: "zai", pattern: /glm|zhipu|\bzai\b/ },
  { id: "kimi", name: "Kimi", logo: "kimi", pattern: /kimi|moonshot|k2d6-agent|k3-agent|(?:^|[^a-z0-9])k[23](?:[-._]|$)/ },
  { id: "mistral", name: "Mistral", logo: "mistral", pattern: /mistral|mixtral|codestral/ },
  // "llama" must start a word: "ollama" is a local runner, not Meta.
  { id: "meta", name: "Meta", logo: "meta", pattern: /(?:^|[^a-z0-9])muse[\s-]*spark|(?:^|[^a-z])llama|meta/ },
  { id: "minimax", name: "MiniMax", logo: "minimax", pattern: /minimax/ },
  { id: "doubao", name: "Doubao", logo: "doubao", pattern: /doubao|bytedance/ },
  { id: "hunyuan", name: "Hunyuan", logo: "hunyuan", pattern: /hunyuan/ },
  { id: "cohere", name: "Cohere", logo: "cohere", pattern: /command-r|cohere|aya-/ },
  { id: "inflection", name: "Inflection", logo: "pi", pattern: /^pi$|^pi-|inflection/ },
  { id: "cursor", name: "Cursor", logo: "cursor", pattern: /cursor|composer/ },
  { id: "copilot", name: "GitHub Copilot", logo: "copilot", pattern: /copilot|github/ },
  { id: "antigravity", name: "Antigravity", logo: "antigravity", pattern: /antigravity/ },
  { id: "openrouter", name: "OpenRouter", logo: "openrouter", pattern: /openrouter/ },
  { id: "newapi", name: "New API", logo: "newapi", pattern: /new.?api|third.?party/ },
  { id: "mimo", name: "Xiaomi MiMo", logo: "xiaomi", pattern: /xiaomi|mimo|micode/ },
] as const;

export function vendorFor(name: string) {
  const key = name.trim().toLowerCase();
  return VENDORS.find((vendor) => vendor.pattern.test(key));
}

/** Provider ids reported by the service that are clients rather than model vendors. */
const CLIENT_NAMES: Record<string, string> = {
  amp: "Amp",
  factory: "Factory Droid",
  droid: "Factory Droid",
  devin: "Devin",
  omp: "Oh My Pi",
  muse: "Muse Code",
  stepfun: "StepFun",
  cline: "Cline",
  typesafe: "TypeSafe",
  alibaba: "Alibaba Cloud",
};

const VENDOR_NAMES: Record<string, string> = Object.fromEntries(
  VENDORS.map((vendor) => [vendor.id, vendor.name]),
);

export function providerFor(name: string): string {
  return vendorFor(name)?.id ?? "other";
}

export function providerName(provider: string): string {
  if (provider === "other") return "其他";
  return VENDOR_NAMES[provider] ?? CLIENT_NAMES[provider] ?? provider;
}
