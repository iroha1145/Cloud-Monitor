import { Bot } from "lucide-react";
import type { CSSProperties } from "react";
import "./brand-icons.css";
import { vendorFor } from "./vendors";

const logoIds = new Set([
  "alibaba",
  "amp",
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
  "devin",
  "doubao",
  "droid",
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
  "newapi",
  "ollama",
  "omp",
  "openclaw",
  "opencode",
  "openrouter",
  "pi",
  "proma",
  "qoder",
  "qodercn",
  "qwen",
  "reasonix",
  "stepfun",
  "trae",
  "typesafe",
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
  muse: "meta",
  musecode: "meta",
  "muse-code": "meta",
  factory: "droid",
  factorydroid: "droid",
  ohmypi: "omp",
  alibabacloud: "alibaba",
  clinepass: "cline",
  kilo: "kilocode",
  zcode: "zai",
  zaiteam: "zai",
  volc: "volcengine",
  cherrystudioapp: "cherrystudio",
};

/** Resolve the same client and vendor artwork used by the original dashboard. */
export function brandLogoId(name: string): string | null {
  const raw = name.trim().toLowerCase();
  const key = raw.replace(/[^a-z0-9-]/g, "");
  const direct = aliases[key] || key;
  if (logoIds.has(direct)) return direct;
  return vendorFor(raw)?.logo ?? null;
}

export interface BrandIconProps {
  name: string;
  size?: number;
}

/** Brand marks are monochrome masks that follow the theme's ink colour. */
export function BrandIcon({ name, size = 34 }: BrandIconProps) {
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
      className="brand-icon"
      style={style}
      data-brand={logo || "unknown"}
      aria-hidden="true"
    >
      {logo ? (
        <span className="brand-icon-mark" />
      ) : (
        <Bot className="brand-icon-fallback" strokeWidth={1.7} />
      )}
    </span>
  );
}
