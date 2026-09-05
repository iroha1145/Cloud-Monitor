import { Bot } from "lucide-react";
import type { CSSProperties } from "react";
import "./brand-icons.css";

const logoIds = new Set([
  "antigravity",
  "cherrystudio",
  "claude",
  "cline",
  "codebuddy",
  "codex",
  "cohere",
  "commandcode",
  "copilot",
  "cursor",
  "deepseek",
  "doubao",
  "dsh",
  "gemini",
  "grok",
  "hermes-agent",
  "hunyuan",
  "kilocode",
  "kimi",
  "kiro",
  "meta",
  "minimax",
  "mistral",
  "moonshot",
  "newapi",
  "ollama",
  "openclaw",
  "opencode",
  "openrouter",
  "pi",
  "proma",
  "qoder",
  "qodercn",
  "qwen",
  "reasonix",
  "trae",
  "volcengine",
  "workbuddy",
  "xai",
  "xiaomi",
  "zai",
  "zed",
]);

const aliases: Record<string, string> = {
  hermes: "hermes-agent",
  grok: "xai",
  xai: "grok",
  micode: "xiaomi",
  mimo: "xiaomi",
  zcode: "zai",
  zaiteam: "zai",
  thirdparty: "newapi",
  anthropic: "claude",
  openai: "codex",
  chatgpt: "codex",
  google: "gemini",
  github: "copilot",
  zhipu: "zai",
  moonshot: "kimi",
  bytedance: "doubao",
  volc: "volcengine",
  cherrystudioapp: "cherrystudio",
};

/** Resolve the same client and vendor artwork used by the original dashboard. */
export function brandLogoId(name: string): string | null {
  const raw = name.trim().toLowerCase();
  const key = raw.replace(/[^a-z0-9-]/g, "");
  const direct = aliases[key] || key;
  if (logoIds.has(direct)) return direct;
  const vendors: [RegExp, string][] = [
    [/claude|anthropic|sonnet|opus|haiku/, "claude"],
    [/gpt|openai|chatgpt|codex|(?:^|[^a-z])o[1-9](?:[-.]|$)/, "codex"],
    [/gemini|gemma|google/, "gemini"],
    [/grok|xai/, "grok"],
    [/deepseek/, "deepseek"],
    [/qwen|qwq/, "qwen"],
    [/glm|zhipu|\bzai\b/, "zai"],
    [/kimi|moonshot|(?:^|[^a-z0-9])k3(?:[-._]|$)/, "kimi"],
    [/mistral|mixtral|codestral/, "mistral"],
    [/llama|meta/, "meta"],
    [/minimax/, "minimax"],
    [/doubao|bytedance/, "doubao"],
    [/hunyuan/, "hunyuan"],
    [/command-r|cohere|aya-/, "cohere"],
    [/^pi$|^pi-|inflection/, "pi"],
    [/cursor/, "cursor"],
    [/copilot|github/, "copilot"],
    [/antigravity/, "antigravity"],
    [/openrouter/, "openrouter"],
    [/new.?api|third.?party/, "newapi"],
    [/xiaomi|mimo|micode/, "xiaomi"],
  ];
  return vendors.find(([pattern]) => pattern.test(raw))?.[1] || null;
}

export interface BrandIconProps {
  name: string;
  size?: number;
  /** Accepted for compatibility; brand marks always follow the monochrome theme. */
  color?: string;
  className?: string;
  title?: string;
}

export function BrandIcon({
  name,
  size = 34,
  className = "",
  title,
}: BrandIconProps) {
  const logo = brandLogoId(name);
  const style = {
    "--brand-size": `${size}px`,
    ...(logo
      ? {
          "--brand-image": `url("${new URL(`${import.meta.env.BASE_URL}client-logos/${logo}.svg`, document.baseURI).href}")`,
        }
      : {}),
  } as CSSProperties;
  return (
    <span
      className={`brand-icon ${className}`.trim()}
      style={style}
      data-brand={logo || "unknown"}
      title={title}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {logo ? (
        <span className="brand-icon-mark" />
      ) : (
        <Bot className="brand-icon-fallback" strokeWidth={1.7} />
      )}
    </span>
  );
}
