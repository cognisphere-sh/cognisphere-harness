import type { CredField, ProviderCatalogEntry } from "./types.js";

/**
 * Catalog of providers + curated model shortlists, mirroring
 * `@earendil-works/pi-coding-agent`'s provider surface (see
 * `packages/coding-agent/docs/providers.md` and
 * `packages/ai/src/env-api-keys.ts`). The Models settings page lets
 * operators supply credentials per provider and toggle which of these
 * models agents may select; custom model IDs not in the curated list
 * can be appended via the UI.
 *
 * Out of scope for v0: OAuth subscription auth (Claude Pro/Max, ChatGPT
 * Codex, GitHub Copilot). The `anthropic` entry below covers the
 * `ANTHROPIC_API_KEY` path; Pro/Max OAuth lands later. Bedrock / Vertex
 * / Azure / Cloudflare are in scope as multi-cred providers.
 *
 * SOURCE OF TRUTH for provider IDs and env-var names:
 *   temp/pi-mono/packages/ai/src/types.ts (KnownProvider union)
 *   temp/pi-mono/packages/ai/src/env-api-keys.ts (envMap)
 * Keep this file in sync on each pi-coding-agent upgrade — the
 * `KnownProvider` union below is a copy of pi-ai's; entries declared
 * here are typechecked against it.
 */

// Mirrored from pi-mono/packages/ai/src/types.ts:23. If this drifts,
// catalog ids below will fail to typecheck — that's the alarm.
export type KnownProvider =
  | "amazon-bedrock"
  | "anthropic"
  | "google"
  | "google-vertex"
  | "openai"
  | "azure-openai-responses"
  | "openai-codex"
  | "deepseek"
  | "github-copilot"
  | "xai"
  | "groq"
  | "cerebras"
  | "openrouter"
  | "vercel-ai-gateway"
  | "zai"
  | "mistral"
  | "minimax"
  | "minimax-cn"
  | "moonshotai"
  | "moonshotai-cn"
  | "huggingface"
  | "fireworks"
  | "together"
  | "opencode"
  | "opencode-go"
  | "kimi-coding"
  | "cloudflare-workers-ai"
  | "cloudflare-ai-gateway"
  | "xiaomi"
  | "xiaomi-token-plan-cn"
  | "xiaomi-token-plan-ams"
  | "xiaomi-token-plan-sgp";

// Single-API-key providers all share the same one-field schema; this
// helper keeps the catalog readable.
function apiKeyOnly(envVar: string): CredField[] {
  return [
    {
      key: "apiKey",
      envVar,
      label: "API key",
      secret: true,
      required: true,
    },
  ];
}

interface CatalogEntry extends ProviderCatalogEntry {
  id: KnownProvider;
}

export const PROVIDER_CATALOG: CatalogEntry[] = [
  // ── single-key API providers ─────────────────────────────────────
  {
    id: "anthropic",
    displayName: "Anthropic",
    credentials: apiKeyOnly("ANTHROPIC_API_KEY"),
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
    credentials: apiKeyOnly("OPENAI_API_KEY"),
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
    credentials: apiKeyOnly("GEMINI_API_KEY"),
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
    credentials: apiKeyOnly("DEEPSEEK_API_KEY"),
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "mistral",
    displayName: "Mistral",
    credentials: apiKeyOnly("MISTRAL_API_KEY"),
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
    credentials: apiKeyOnly("GROQ_API_KEY"),
    models: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "moonshotai/kimi-k2-instruct",
    ],
  },
  {
    id: "cerebras",
    displayName: "Cerebras",
    credentials: apiKeyOnly("CEREBRAS_API_KEY"),
    models: ["llama3.3-70b", "llama-4-scout-17b-16e-instruct"],
  },
  {
    id: "xai",
    displayName: "xAI",
    credentials: apiKeyOnly("XAI_API_KEY"),
    models: ["grok-4", "grok-3", "grok-3-mini"],
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    credentials: apiKeyOnly("OPENROUTER_API_KEY"),
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
    credentials: apiKeyOnly("AI_GATEWAY_API_KEY"),
    models: [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5",
      "google/gemini-2.5-pro",
    ],
  },
  {
    id: "zai",
    displayName: "ZAI",
    credentials: apiKeyOnly("ZAI_API_KEY"),
    models: ["glm-4.6", "glm-4.5"],
  },
  {
    id: "fireworks",
    displayName: "Fireworks",
    credentials: apiKeyOnly("FIREWORKS_API_KEY"),
    models: [
      "accounts/fireworks/models/deepseek-v3",
      "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct",
    ],
  },
  {
    id: "kimi-coding",
    displayName: "Kimi For Coding",
    credentials: apiKeyOnly("KIMI_API_KEY"),
    models: ["kimi-k2-coding"],
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    credentials: apiKeyOnly("MINIMAX_API_KEY"),
    models: ["minimax-m2"],
  },
  {
    id: "minimax-cn",
    displayName: "MiniMax (China)",
    credentials: apiKeyOnly("MINIMAX_CN_API_KEY"),
    models: [],
  },
  {
    id: "moonshotai",
    displayName: "Moonshot AI",
    credentials: apiKeyOnly("MOONSHOT_API_KEY"),
    models: [],
  },
  {
    id: "moonshotai-cn",
    displayName: "Moonshot AI (China)",
    credentials: apiKeyOnly("MOONSHOT_API_KEY"),
    models: [],
  },
  {
    id: "huggingface",
    displayName: "Hugging Face",
    credentials: apiKeyOnly("HF_TOKEN"),
    models: [],
  },
  {
    id: "opencode",
    displayName: "OpenCode Zen",
    credentials: apiKeyOnly("OPENCODE_API_KEY"),
    models: [],
  },
  {
    id: "opencode-go",
    displayName: "OpenCode Go",
    credentials: apiKeyOnly("OPENCODE_API_KEY"),
    models: [],
  },
  {
    id: "together",
    displayName: "Together AI",
    credentials: apiKeyOnly("TOGETHER_API_KEY"),
    models: [],
  },
  {
    id: "xiaomi",
    displayName: "Xiaomi MiMo",
    credentials: apiKeyOnly("XIAOMI_API_KEY"),
    models: [],
  },
  {
    id: "xiaomi-token-plan-cn",
    displayName: "Xiaomi MiMo Token Plan (China)",
    credentials: apiKeyOnly("XIAOMI_TOKEN_PLAN_CN_API_KEY"),
    models: [],
  },
  {
    id: "xiaomi-token-plan-ams",
    displayName: "Xiaomi MiMo Token Plan (Amsterdam)",
    credentials: apiKeyOnly("XIAOMI_TOKEN_PLAN_AMS_API_KEY"),
    models: [],
  },
  {
    id: "xiaomi-token-plan-sgp",
    displayName: "Xiaomi MiMo Token Plan (Singapore)",
    credentials: apiKeyOnly("XIAOMI_TOKEN_PLAN_SGP_API_KEY"),
    models: [],
  },

  // ── multi-cred cloud providers ───────────────────────────────────
  {
    id: "azure-openai-responses",
    displayName: "Azure OpenAI",
    credentials: [
      {
        key: "apiKey",
        envVar: "AZURE_OPENAI_API_KEY",
        label: "API key",
        secret: true,
        required: true,
      },
      {
        key: "baseUrl",
        envVar: "AZURE_OPENAI_BASE_URL",
        label: "Base URL",
        secret: false,
        required: false,
        placeholder: "https://your-resource.openai.azure.com",
        helpText: "Either this or Resource name is required.",
      },
      {
        key: "resourceName",
        envVar: "AZURE_OPENAI_RESOURCE_NAME",
        label: "Resource name",
        secret: false,
        required: false,
        placeholder: "your-resource",
        helpText: "Used if Base URL is not set.",
      },
      {
        key: "apiVersion",
        envVar: "AZURE_OPENAI_API_VERSION",
        label: "API version",
        secret: false,
        required: false,
        placeholder: "2024-02-01",
      },
      {
        key: "deploymentMap",
        envVar: "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
        label: "Deployment name map",
        secret: false,
        required: false,
        placeholder: "gpt-4=my-gpt4,gpt-4o=my-gpt4o",
      },
    ],
    models: [],
    notes: "Set Base URL or Resource name (one of). Root endpoints normalize to /openai/v1.",
  },
  {
    id: "amazon-bedrock",
    displayName: "Amazon Bedrock",
    credentials: [
      {
        key: "accessKeyId",
        envVar: "AWS_ACCESS_KEY_ID",
        label: "AWS Access Key ID",
        secret: false,
        required: false,
        helpText: "IAM keys path. Leave blank to use AWS_PROFILE or bearer token instead.",
      },
      {
        key: "secretAccessKey",
        envVar: "AWS_SECRET_ACCESS_KEY",
        label: "AWS Secret Access Key",
        secret: true,
        required: false,
      },
      {
        key: "sessionToken",
        envVar: "AWS_SESSION_TOKEN",
        label: "AWS Session Token (optional)",
        secret: true,
        required: false,
      },
      {
        key: "profile",
        envVar: "AWS_PROFILE",
        label: "AWS Profile",
        secret: false,
        required: false,
        helpText: "Use a named profile from ~/.aws/credentials.",
      },
      {
        key: "bearerToken",
        envVar: "AWS_BEARER_TOKEN_BEDROCK",
        label: "Bedrock Bearer Token",
        secret: true,
        required: false,
      },
      {
        key: "region",
        envVar: "AWS_REGION",
        label: "Region",
        secret: false,
        required: false,
        placeholder: "us-east-1",
      },
    ],
    models: [],
    notes:
      "Provide one of: IAM keys (Access Key + Secret), AWS Profile, or Bearer Token. ECS task roles and IRSA are picked up automatically from the host.",
  },
  {
    id: "google-vertex",
    displayName: "Google Vertex AI",
    credentials: [
      {
        key: "serviceAccountKey",
        // Special-cased in agent-manager.resolveAndValidateProvider: written
        // to <agentDir>/.vertex-sa.json (0600), then GOOGLE_APPLICATION_CREDENTIALS
        // is set to that path on the spawned pi child.
        envVar: "GOOGLE_APPLICATION_CREDENTIALS",
        label: "Service account JSON",
        secret: true,
        required: false,
        multiline: true,
        helpText:
          "Paste the full service account key JSON. Stored to disk on agent start; pi reads it via GOOGLE_APPLICATION_CREDENTIALS. Leave blank to use ADC from `gcloud auth application-default login` on the host.",
      },
      {
        key: "projectId",
        envVar: "GOOGLE_CLOUD_PROJECT",
        label: "GCP Project ID",
        secret: false,
        required: true,
      },
      {
        key: "location",
        envVar: "GOOGLE_CLOUD_LOCATION",
        label: "Location",
        secret: false,
        required: false,
        placeholder: "us-central1",
      },
    ],
    models: [],
  },
  {
    id: "cloudflare-ai-gateway",
    displayName: "Cloudflare AI Gateway",
    credentials: [
      {
        key: "apiKey",
        envVar: "CLOUDFLARE_API_KEY",
        label: "Cloudflare API Token",
        secret: true,
        required: true,
      },
      {
        key: "accountId",
        envVar: "CLOUDFLARE_ACCOUNT_ID",
        label: "Account ID",
        secret: false,
        required: true,
      },
      {
        key: "gatewayId",
        envVar: "CLOUDFLARE_GATEWAY_ID",
        label: "Gateway ID",
        secret: false,
        required: true,
        helpText: "Create at dash.cloudflare.com → AI → AI Gateway.",
      },
    ],
    models: [],
  },
  {
    id: "cloudflare-workers-ai",
    displayName: "Cloudflare Workers AI",
    credentials: [
      {
        key: "apiKey",
        envVar: "CLOUDFLARE_API_KEY",
        label: "Cloudflare API Token",
        secret: true,
        required: true,
      },
      {
        key: "accountId",
        envVar: "CLOUDFLARE_ACCOUNT_ID",
        label: "Account ID",
        secret: false,
        required: true,
      },
    ],
    models: [],
  },
];

export function findProviderInCatalog(
  id: string,
): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}
