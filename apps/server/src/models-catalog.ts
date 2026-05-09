import type { ProviderCatalogEntry } from "./types.js";

/**
 * Curated catalog of API-key providers + a starter list of recent models
 * for each. Sourced from pi's `providers.md` and `models.generated.ts`.
 * The Models settings page lets operators paste an API key and toggle
 * which of these models agents may select; custom model IDs (not in this
 * list) can also be appended via the UI.
 *
 * Out of scope here: subscription auth (ChatGPT Plus/Pro, Claude Pro/Max,
 * GitHub Copilot) and cloud providers needing OAuth/AWS env (Bedrock,
 * Vertex, Azure). Operators wire those up via env vars on the host.
 */
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    models: [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
    ],
  },
  {
    id: "openai",
    displayName: "OpenAI",
    envVar: "OPENAI_API_KEY",
    models: [
      "gpt-5.1",
      "gpt-5",
      "gpt-4.1",
      "gpt-4o",
      "gpt-4o-mini",
      "o4-mini",
      "o3",
      "o3-mini",
    ],
  },
  {
    id: "google",
    displayName: "Google Gemini",
    envVar: "GEMINI_API_KEY",
    models: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
    ],
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    envVar: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "mistral",
    displayName: "Mistral",
    envVar: "MISTRAL_API_KEY",
    models: [
      "mistral-large-latest",
      "mistral-medium-latest",
      "mistral-small-latest",
      "codestral-latest",
    ],
  },
  {
    id: "groq",
    displayName: "Groq",
    envVar: "GROQ_API_KEY",
    models: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "moonshotai/kimi-k2-instruct",
    ],
  },
  {
    id: "cerebras",
    displayName: "Cerebras",
    envVar: "CEREBRAS_API_KEY",
    models: ["llama3.3-70b", "llama-4-scout-17b-16e-instruct"],
  },
  {
    id: "xai",
    displayName: "xAI",
    envVar: "XAI_API_KEY",
    models: ["grok-4", "grok-3", "grok-3-mini"],
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    models: [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-chat",
    ],
  },
  {
    id: "vercel-ai-gateway",
    displayName: "Vercel AI Gateway",
    envVar: "AI_GATEWAY_API_KEY",
    models: [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5",
      "google/gemini-2.5-pro",
    ],
  },
  {
    id: "zai",
    displayName: "ZAI",
    envVar: "ZAI_API_KEY",
    models: ["glm-4.6", "glm-4.5"],
  },
  {
    id: "fireworks",
    displayName: "Fireworks",
    envVar: "FIREWORKS_API_KEY",
    models: [
      "accounts/fireworks/models/deepseek-v3",
      "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct",
    ],
  },
  {
    id: "kimi-coding",
    displayName: "Kimi For Coding",
    envVar: "KIMI_API_KEY",
    models: ["kimi-k2-coding"],
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    envVar: "MINIMAX_API_KEY",
    models: ["minimax-m2"],
  },
  {
    id: "huggingface",
    displayName: "Hugging Face",
    envVar: "HF_TOKEN",
    models: [],
  },
  {
    id: "opencode",
    displayName: "OpenCode Zen",
    envVar: "OPENCODE_API_KEY",
    models: [],
  },
];

export function findProviderInCatalog(
  id: string,
): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}
