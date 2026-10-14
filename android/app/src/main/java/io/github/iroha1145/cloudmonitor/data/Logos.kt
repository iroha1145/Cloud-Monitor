package io.github.iroha1145.cloudmonitor.data

import java.util.Locale

private val CLIENT_LOGO_ALIAS = mapOf(
    "hermes" to "hermes-agent",
    "grok" to "xai",
    "xai" to "grok",
    "micode" to "xiaomi",
    "mimo" to "xiaomi",
    "zcode" to "zai",
    "zaiteam" to "zai",
    "thirdparty" to "newapi",
    "anthropic" to "claude",
    "openai" to "codex",
    "chatgpt" to "codex",
    "google" to "gemini",
    "github" to "copilot",
    "qodercn" to "qoder",
    "zhipu" to "zai",
    "moonshot" to "kimi",
    "bytedance" to "doubao",
    "volc" to "volcengine",
    "muse" to "meta",
    "musecode" to "meta",
    "muse-code" to "meta",
    "mcode" to "minimax",
    "minimaxcode" to "minimax",
    "minimax-code" to "minimax",
    "factory" to "droid",
    "factorydroid" to "droid",
    "ohmypi" to "omp",
    "alibabacloud" to "alibaba",
    "clinepass" to "cline",
    "kilo" to "kilocode",
    "cherrystudioapp" to "cherrystudio",
)

private val CLIENT_LOGO_IDS = setOf(
    "alibaba", "amp", "antigravity", "catpaw", "cherrystudio", "claude", "cline",
    "codebuddy", "codex", "cohere", "commandcode", "copilot", "cursor", "deepseek",
    "devin", "doubao", "droid", "dsh", "fx", "gemini", "grok", "hermes-agent",
    "hunyuan", "kilocode", "kimi", "kiro", "lmstudio", "meta", "minimax", "mistral",
    "moonshot", "newapi", "ollama", "omp", "openclaw", "opencode", "openrouter",
    "pi", "proma", "qoder", "qodercn", "qwen", "reasonix", "stepfun", "sub2api",
    "trae", "typesafe", "unsloth", "volcengine", "workbuddy", "xai", "xiaomi",
    "zai", "zed",
)

fun modelVendorId(name: String?): String {
    val s = name.orEmpty().lowercase(Locale.US)
    if (s.isEmpty()) return ""
    if ("claude" in s || "anthropic" in s || "sonnet" in s || "opus" in s || "haiku" in s) return "claude"
    if ("gpt" in s || "openai" in s || "chatgpt" in s || "codex" in s || Regex("""(?:^|[^a-z])o[1-9](?:[-.]|$)""").containsMatchIn(s)) return "codex"
    if ("gemini" in s || "gemma" in s) return "gemini"
    if ("grok" in s || "xai" in s) return "grok"
    if ("deepseek" in s) return "deepseek"
    if ("qwen" in s || "qwq" in s) return "qwen"
    if ("glm" in s || "zhipu" in s || Regex("""\bzai\b""").containsMatchIn(s)) return "zai"
    if ("kimi" in s || "moonshot" in s || Regex("""(?:^|[^a-z0-9])(k2d6-agent|k3-agent|k[23])(?:[-._]|$)""").containsMatchIn(s)) return "kimi"
    if ("mistral" in s || "mixtral" in s || "codestral" in s) return "mistral"
    if (Regex("""(?:^|[^a-z0-9])muse[\s-]*spark""").containsMatchIn(s) || Regex("""(?:^|[^a-z])llama""").containsMatchIn(s) || "meta" in s) return "meta"
    if ("minimax" in s) return "minimax"
    if ("doubao" in s) return "doubao"
    if ("hunyuan" in s) return "hunyuan"
    if ("command-r" in s || "cohere" in s || "aya-" in s) return "cohere"
    if (s == "pi" || s.startsWith("pi-") || "inflection" in s) return "pi"
    if ("cursor" in s || "composer" in s) return "cursor"
    if ("copilot" in s) return "copilot"
    return ""
}

fun clientLogoId(name: String?): String {
    val raw = name.orEmpty().trim().lowercase(Locale.US)
    val key = raw.replace(Regex("[^a-z0-9-]"), "")
    val id = CLIENT_LOGO_ALIAS[key] ?: key
    if (id in CLIENT_LOGO_IDS) return id
    val vendor = modelVendorId(raw)
    return if (vendor in CLIENT_LOGO_IDS) vendor else ""
}

fun logoAssetPath(name: String?): String? {
    val id = clientLogoId(name)
    return if (id.isNotEmpty()) "file:///android_asset/logos/$id.svg" else null
}
