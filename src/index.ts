/**
 * ClawRouter — Smart LLM Router (Direct API Keys)
 *
 * Routes each request to the cheapest model that can handle it,
 * using your own provider API keys. No crypto, no middleman.
 *
 * Usage:
 *   openclaw plugins install ./ClawRouter
 *   # Configure API keys via env vars or ~/.openclaw/clawrouter/config.json
 *   openclaw models set clawrouter/auto
 */

import type {
  OpenClawPluginDefinition,
  OpenClawPluginApi,
  PluginCommandContext,
  OpenClawPluginCommandDefinition,
} from "./types.js";
import { clawrouterProvider, setActiveProxy } from "./provider.js";
import { startProxy, getProxyPort } from "./proxy.js";
import {
  loadApiKeys,
  getConfiguredProviders,
  hasOpenRouter,
  getAccessibleProviders,
  type ApiKeysConfig,
} from "./api-keys.js";
import type { RoutingConfig } from "./router/index.js";
import { OPENCLAW_MODELS } from "./models.js";
import {
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { readTextFileSync } from "./fs-read.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION } from "./version.js";
import { getStats, formatStatsAscii, clearStats } from "./stats.js";
import { buildPartnerTools, PARTNER_SERVICES } from "./partners/index.js";
import { refreshOpenRouterModels } from "./openrouter-models.js";

/**
 * Wait for proxy health check to pass (quick check, not RPC).
 * Returns true if healthy within timeout, false otherwise.
 */
async function waitForProxyHealth(port: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {
      // Proxy not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Detect if we're running in shell completion mode.
 * When `openclaw completion --shell zsh` runs, it loads plugins but only needs
 * the completion script output - any stdout logging pollutes the script and
 * causes zsh to interpret colored text like `[plugins]` as glob patterns.
 */
function isCompletionMode(): boolean {
  const args = process.argv;
  // Check for: openclaw completion --shell <shell>
  // argv[0] = node/bun, argv[1] = openclaw, argv[2] = completion
  return args.some((arg, i) => arg === "completion" && i >= 1 && i <= 3);
}

/**
 * Detect if we're running in gateway mode.
 * The proxy should ONLY start when the gateway is running.
 * During CLI commands (plugins, models, etc), the proxy keeps the process alive.
 */
function isGatewayMode(): boolean {
  const args = process.argv;
  // Gateway mode is: openclaw gateway start/restart/stop
  return args.includes("gateway");
}

/**
 * Inject ClawRouter models config into OpenClaw config file.
 * This is required because registerProvider() alone doesn't make models available.
 *
 * CRITICAL: This function must be idempotent and handle ALL edge cases:
 * - Config file doesn't exist (create it)
 * - Config file exists but is empty/invalid (reinitialize)
 * - clawrouter provider exists but has undefined fields (fix them)
 * - Config exists but uses old port/models (update them)
 *
 * This function is called on EVERY plugin load to ensure config is always correct.
 */
function injectModelsConfig(logger: { info: (msg: string) => void }): void {
  const configDir = join(homedir(), ".openclaw");
  const configPath = join(configDir, "openclaw.json");

  let config: Record<string, unknown> = {};
  let needsWrite = false;

  // Create config directory if it doesn't exist
  if (!existsSync(configDir)) {
    try {
      mkdirSync(configDir, { recursive: true });
      logger.info("Created OpenClaw config directory");
    } catch (err) {
      logger.info(
        `Failed to create config dir: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }

  // Load existing config or create new one
  // IMPORTANT: On parse failure, we backup and skip writing to avoid clobbering
  // other plugins' config (e.g. Telegram channels). This prevents a race condition
  // where a partial/corrupt config file causes us to overwrite everything with
  // only our models+agents sections.
  if (existsSync(configPath)) {
    try {
      const content = readTextFileSync(configPath).trim();
      if (content) {
        config = JSON.parse(content);
      } else {
        logger.info("OpenClaw config is empty, initializing");
        needsWrite = true;
      }
    } catch (err) {
      // Config file exists but is corrupt/invalid JSON — likely a partial write
      // from another plugin or a race condition during gateway restart.
      // Backup the corrupt file and SKIP writing to avoid losing other config.
      const backupPath = `${configPath}.backup.${Date.now()}`;
      try {
        copyFileSync(configPath, backupPath);
        logger.info(`Config parse failed, backed up to ${backupPath}`);
      } catch {
        logger.info("Config parse failed, could not create backup");
      }
      logger.info(
        `Skipping config injection (corrupt file): ${err instanceof Error ? err.message : String(err)}`,
      );
      return; // Don't write — we'd lose other plugins' config
    }
  } else {
    logger.info("OpenClaw config not found, creating");
    needsWrite = true;
  }

  // Initialize config structure
  if (!config.models) {
    config.models = {};
    needsWrite = true;
  }
  const models = config.models as Record<string, unknown>;
  if (!models.providers) {
    models.providers = {};
    needsWrite = true;
  }

  const proxyPort = getProxyPort();
  const expectedBaseUrl = `http://127.0.0.1:${proxyPort}/v1`;

  const providers = models.providers as Record<string, unknown>;

  if (!providers.clawrouter) {
    // Create new clawrouter provider config
    providers.clawrouter = {
      baseUrl: expectedBaseUrl,
      api: "openai-completions",
      apiKey: "local-proxy",
      models: OPENCLAW_MODELS,
    };
    logger.info("Injected ClawRouter provider config");
    needsWrite = true;
  } else {
    // Validate and fix existing clawrouter config
    const clawrouter = providers.clawrouter as Record<string, unknown>;
    let fixed = false;

    // Fix: explicitly check for undefined/missing fields
    if (!clawrouter.baseUrl || clawrouter.baseUrl !== expectedBaseUrl) {
      clawrouter.baseUrl = expectedBaseUrl;
      fixed = true;
    }
    // Ensure api field is present
    if (!clawrouter.api) {
      clawrouter.api = "openai-completions";
      fixed = true;
    }
    // Ensure apiKey is present (required by ModelRegistry for /model picker)
    if (!clawrouter.apiKey) {
      clawrouter.apiKey = "local-proxy";
      fixed = true;
    }
    // Always refresh models list (ensures new models/aliases are available)
    // Check both length AND content - new models may be added without changing count
    const currentModels = clawrouter.models as Array<{ id?: string }>;
    const currentModelIds = new Set(
      Array.isArray(currentModels) ? currentModels.map((m) => m?.id).filter(Boolean) : [],
    );
    const expectedModelIds = OPENCLAW_MODELS.map((m) => m.id);
    const needsModelUpdate =
      !currentModels ||
      !Array.isArray(currentModels) ||
      currentModels.length !== OPENCLAW_MODELS.length ||
      expectedModelIds.some((id) => !currentModelIds.has(id));

    if (needsModelUpdate) {
      clawrouter.models = OPENCLAW_MODELS;
      fixed = true;
      logger.info(`Updated models list (${OPENCLAW_MODELS.length} models)`);
    }

    if (fixed) {
      logger.info("Fixed incomplete ClawRouter provider config");
      needsWrite = true;
    }
  }

  // Set clawrouter/auto as default model ONLY on first install (not every load!)
  // This respects user's model selection and prevents hijacking their choice.
  if (!config.agents) {
    config.agents = {};
    needsWrite = true;
  }
  const agents = config.agents as Record<string, unknown>;
  if (!agents.defaults) {
    agents.defaults = {};
    needsWrite = true;
  }
  const defaults = agents.defaults as Record<string, unknown>;
  if (!defaults.model) {
    defaults.model = {};
    needsWrite = true;
  }
  const model = defaults.model as Record<string, unknown>;

  // ONLY set default if no primary model exists (first install)
  // Do NOT override user's selection on subsequent loads
  if (!model.primary) {
    model.primary = "clawrouter/auto";
    logger.info("Set default model to clawrouter/auto (first install)");
    needsWrite = true;
  }

  // Populate agents.defaults.models (the allowlist) with top ClawRouter models.
  // OpenClaw uses this as a whitelist — only listed models appear in the /model picker.
  // We show the 16 most popular models to keep the picker clean.
  // Existing non-clawrouter entries are preserved (e.g. from other providers).
  const TOP_MODELS = [
    "auto",
    "free",
    "eco",
    "premium",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-opus-4.6",
    "anthropic/claude-haiku-4.5",
    "openai/gpt-5.2",
    "openai/gpt-4o",
    "openai/o3",
    "google/gemini-3.1-pro",
    "google/gemini-3-flash-preview",
    "deepseek/deepseek-chat",
    "moonshot/kimi-k2.5",
    "xai/grok-3",
    "minimax/minimax-m2.5",
  ];
  if (!defaults.models || typeof defaults.models !== "object" || Array.isArray(defaults.models)) {
    defaults.models = {};
    needsWrite = true;
  }
  const allowlist = defaults.models as Record<string, unknown>;
  // Additive-only: add TOP_MODELS entries if missing, never delete user-defined entries.
  // Preserves any clawrouter/* IDs the user has manually added outside this curated list.
  let addedCount = 0;
  for (const id of TOP_MODELS) {
    const key = `clawrouter/${id}`;
    if (!allowlist[key]) {
      allowlist[key] = {};
      addedCount++;
    }
  }
  if (addedCount > 0) {
    needsWrite = true;
    logger.info(`Added ${addedCount} models to allowlist (${TOP_MODELS.length} total)`);
  }

  // Write config file if any changes were made
  // Use atomic write (temp file + rename) to prevent partial writes that could
  // corrupt the config and cause other plugins to lose their settings on next load.
  if (needsWrite) {
    try {
      const tmpPath = `${configPath}.tmp.${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(config, null, 2));
      renameSync(tmpPath, configPath);
      logger.info("Smart routing enabled (clawrouter/auto)");
    } catch (err) {
      logger.info(`Failed to write config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Inject auth profile for ClawRouter into agent auth stores.
 * OpenClaw's agent system looks for auth credentials even if provider has auth: [].
 * We inject a placeholder so the lookup succeeds (proxy handles auth internally).
 */
function injectAuthProfile(logger: { info: (msg: string) => void }): void {
  const agentsDir = join(homedir(), ".openclaw", "agents");

  // Create agents directory if it doesn't exist
  if (!existsSync(agentsDir)) {
    try {
      mkdirSync(agentsDir, { recursive: true });
    } catch (err) {
      logger.info(
        `Could not create agents dir: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }

  try {
    // Find all agent directories
    let agents = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    // Always ensure "main" agent has auth (most common agent)
    if (!agents.includes("main")) {
      agents = ["main", ...agents];
    }

    for (const agentId of agents) {
      const authDir = join(agentsDir, agentId, "agent");
      const authPath = join(authDir, "auth-profiles.json");

      // Create agent dir if needed
      if (!existsSync(authDir)) {
        try {
          mkdirSync(authDir, { recursive: true });
        } catch {
          continue; // Skip if we can't create the dir
        }
      }

      // Load or create auth-profiles.json with correct OpenClaw format
      // Format: { version: 1, profiles: { "provider:profileId": { type, provider, key } } }
      let store: { version: number; profiles: Record<string, unknown> } = {
        version: 1,
        profiles: {},
      };
      if (existsSync(authPath)) {
        try {
          const existing = JSON.parse(readTextFileSync(authPath));
          // Check if valid OpenClaw format (has version and profiles)
          if (existing.version && existing.profiles) {
            store = existing;
          }
          // Old format without version/profiles is discarded and recreated
        } catch {
          // Invalid JSON, use fresh store
        }
      }

      // Check if clawrouter auth already exists (OpenClaw format: profiles["provider:profileId"])
      const profileKey = "clawrouter:default";
      if (store.profiles[profileKey]) {
        continue; // Already configured
      }

      // Inject placeholder auth for clawrouter (OpenClaw format)
      // The proxy handles real auth internally, this just satisfies OpenClaw's lookup
      store.profiles[profileKey] = {
        type: "api_key",
        provider: "clawrouter",
        key: "local-proxy",
      };

      try {
        writeFileSync(authPath, JSON.stringify(store, null, 2));
        logger.info(`Injected ClawRouter auth profile for agent: ${agentId}`);
      } catch (err) {
        logger.info(
          `Could not inject auth for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    logger.info(`Auth injection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Store active proxy handle for cleanup on gateway_stop
let activeProxyHandle: Awaited<ReturnType<typeof startProxy>> | null = null;

/**
 * Start the proxy in the background with API keys.
 * Called from register() because OpenClaw's loader only invokes register(),
 * treating activate() as an alias (def.register ?? def.activate).
 */
async function startProxyInBackground(api: OpenClawPluginApi, apiKeys: ApiKeysConfig): Promise<void> {
  const configuredProviders = getConfiguredProviders(apiKeys);
  const orFallback = hasOpenRouter(apiKeys);
  const accessibleProviders = getAccessibleProviders(apiKeys);
  api.logger.info(`Configured providers: ${configuredProviders.join(", ") || "(none)"}${orFallback ? " (OpenRouter covers all)" : ""}`);

  if (configuredProviders.length === 0) {
    api.logger.warn("No API keys configured! Set OPENROUTER_API_KEY for all models, or individual keys (OPENAI_API_KEY, etc.).");
    return;
  }

  // Resolve routing config overrides from plugin config
  const routingConfig = api.pluginConfig?.routing as Partial<RoutingConfig> | undefined;

  const proxy = await startProxy({
    apiKeys,
    routingConfig,
    onReady: (port) => {
      api.logger.info(`ClawRouter proxy listening on port ${port}`);
    },
    onError: (error) => {
      api.logger.error(`ClawRouter proxy error: ${error.message}`);
    },
    onRouted: (decision) => {
      const cost = decision.costEstimate.toFixed(4);
      const saved = (decision.savings * 100).toFixed(0);
      api.logger.info(
        `[${decision.tier}] ${decision.model} ~$${cost} (saved ${saved}%) | ${decision.reasoning}`,
      );
    },
  });

  setActiveProxy(proxy);
  activeProxyHandle = proxy;

  api.logger.info(`ClawRouter ready — ${accessibleProviders.length} providers accessible, smart routing enabled`);

  // Pre-load OpenRouter model catalog for ID resolution
  if (hasOpenRouter(apiKeys)) {
    const orKey = apiKeys.providers.openrouter.apiKey;
    refreshOpenRouterModels(orKey).catch((err) =>
      api.logger.warn(`Failed to load OpenRouter models: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}

/**
 * /stats command handler for ClawRouter.
 * Shows usage statistics and cost savings.
 */
async function createStatsCommand(): Promise<OpenClawPluginCommandDefinition> {
  return {
    name: "stats",
    description: "Show ClawRouter usage statistics and cost savings",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (ctx: PluginCommandContext) => {
      const arg = ctx.args?.trim().toLowerCase() || "7";

      if (arg === "clear" || arg === "reset") {
        try {
          const { deletedFiles } = await clearStats();
          return {
            text: `Stats cleared — ${deletedFiles} log file(s) deleted. Fresh start!`,
          };
        } catch (err) {
          return {
            text: `Failed to clear stats: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }

      const days = parseInt(arg, 10) || 7;

      try {
        const stats = await getStats(Math.min(days, 30)); // Cap at 30 days
        const ascii = formatStatsAscii(stats);

        return {
          text: ["```", ascii, "```"].join("\n"),
        };
      } catch (err) {
        return {
          text: `Failed to load stats: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * /keys command handler for ClawRouter.
 * Shows configured API key status (no secrets shown).
 */
async function createKeysCommand(apiKeys: ApiKeysConfig): Promise<OpenClawPluginCommandDefinition> {
  return {
    name: "keys",
    description: "Show configured API key status (no secrets shown)",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      const providers = getConfiguredProviders(apiKeys);
      if (providers.length === 0) {
        return {
          text: [
            "**ClawRouter API Keys**",
            "",
            "No API keys configured!",
            "",
            "**Quickest setup (one key -> all models):**",
            "  `OPENROUTER_API_KEY=sk-or-...`",
            "",
            "**Or configure individual providers:**",
            "  `OPENAI_API_KEY=sk-...`",
            "  `ANTHROPIC_API_KEY=sk-ant-...`",
            "  `GOOGLE_API_KEY=AIza...`",
            "  `XAI_API_KEY=xai-...`",
            "  `DEEPSEEK_API_KEY=sk-...`",
            "",
            "**Or edit:** `~/.openclaw/clawrouter/config.json`",
          ].join("\n"),
        };
      }

      const orActive = hasOpenRouter(apiKeys);
      const accessible = getAccessibleProviders(apiKeys);
      const lines = [
        "**ClawRouter API Keys**",
        "",
        ...providers.map((p) => {
          const key = apiKeys.providers[p]?.apiKey || "";
          const masked = key.length > 8 ? key.slice(0, 4) + "..." + key.slice(-4) : "****";
          const label = p === "openrouter" ? `${p} (fallback for all providers)` : p;
          return `  **${label}**: \`${masked}\``;
        }),
        "",
        orActive
          ? `**${accessible.length} providers accessible** (${providers.filter((p) => p !== "openrouter").length} direct + OpenRouter fallback)`
          : `**${providers.length} providers configured**`,
      ];

      return { text: lines.join("\n") };
    },
  };
}

const plugin: OpenClawPluginDefinition = {
  id: "clawrouter",
  name: "ClawRouter",
  description: "Smart LLM router — your keys, smart routing, maximum savings",
  version: VERSION,

  register(api: OpenClawPluginApi) {
    // Check if ClawRouter is disabled via environment variable
    // Usage: CLAWROUTER_DISABLED=true openclaw gateway start
    const isDisabled =
      process["env"].CLAWROUTER_DISABLED === "true" || process["env"].CLAWROUTER_DISABLED === "1";
    if (isDisabled) {
      api.logger.info("ClawRouter disabled (CLAWROUTER_DISABLED=true). Using default routing.");
      return;
    }

    // Skip heavy initialization in completion mode — only completion script is needed
    // Logging to stdout during completion pollutes the script and causes zsh errors
    if (isCompletionMode()) {
      api.registerProvider(clawrouterProvider);
      return;
    }

    // Load API keys from env vars / config file
    const apiKeys = loadApiKeys(api.pluginConfig);

    // Register ClawRouter as a provider (sync — available immediately)
    api.registerProvider(clawrouterProvider);

    // Inject models config into OpenClaw config file
    // This persists the config so models are recognized on restart
    injectModelsConfig(api.logger);

    // Inject auth profiles into agent auth stores
    // OpenClaw's agent system looks for auth even if provider has auth: []
    injectAuthProfile(api.logger);

    // Also set runtime config for immediate availability
    const runtimePort = getProxyPort();
    if (!api.config.models) {
      api.config.models = { providers: {} };
    }
    if (!api.config.models.providers) {
      api.config.models.providers = {};
    }
    api.config.models.providers.clawrouter = {
      baseUrl: `http://127.0.0.1:${runtimePort}/v1`,
      api: "openai-completions",
      apiKey: "local-proxy",
      models: OPENCLAW_MODELS,
    };

    const configuredProviders = getConfiguredProviders(apiKeys);
    api.logger.info(`ClawRouter registered (${configuredProviders.length} providers: ${configuredProviders.join(", ") || "none"})`);

    // Register partner API tools (Twitter/X lookup, etc.)
    try {
      const proxyBaseUrl = `http://127.0.0.1:${runtimePort}`;
      const partnerTools = buildPartnerTools(proxyBaseUrl);
      for (const tool of partnerTools) {
        api.registerTool(tool);
      }
      if (partnerTools.length > 0) {
        api.logger.info(
          `Registered ${partnerTools.length} partner tool(s): ${partnerTools.map((t) => t.name).join(", ")}`,
        );
      }

      // Register /partners command
      api.registerCommand({
        name: "partners",
        description: "List available partner APIs and pricing",
        acceptsArgs: false,
        requireAuth: false,
        handler: async () => {
          if (PARTNER_SERVICES.length === 0) {
            return { text: "No partner APIs available." };
          }

          const lines = ["**Partner APIs** (paid via your ClawRouter account)", ""];

          for (const svc of PARTNER_SERVICES) {
            lines.push(`**${svc.name}** (${svc.partner})`);
            lines.push(`  ${svc.description}`);
            lines.push(`  Tool: \`${`clawrouter_${svc.id}`}\``);
            lines.push(
              `  Pricing: ${svc.pricing.perUnit} per ${svc.pricing.unit} (min ${svc.pricing.minimum}, max ${svc.pricing.maximum})`,
            );
            lines.push(
              `  **How to use:** Ask "Look up Twitter user @elonmusk" or "Get info on these X accounts: @naval, @balajis"`,
            );
            lines.push("");
          }

          return { text: lines.join("\n") };
        },
      });
    } catch (err) {
      api.logger.warn(
        `Failed to register partner tools: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Register /keys command for API key status
    createKeysCommand(apiKeys)
      .then((keysCommand) => {
        api.registerCommand(keysCommand);
      })
      .catch((err) => {
        api.logger.warn(
          `Failed to register /keys command: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    // Register /stats command for usage statistics
    createStatsCommand()
      .then((statsCommand) => {
        api.registerCommand(statsCommand);
      })
      .catch((err) => {
        api.logger.warn(
          `Failed to register /stats command: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    // Register a service with stop() for cleanup on gateway shutdown
    // This prevents EADDRINUSE when the gateway restarts
    api.registerService({
      id: "clawrouter-proxy",
      start: () => {
        // No-op: proxy is started below in non-blocking mode
      },
      stop: async () => {
        // Close proxy on gateway shutdown to release port 8402
        if (activeProxyHandle) {
          try {
            await activeProxyHandle.close();
            api.logger.info("ClawRouter proxy closed");
          } catch (err) {
            api.logger.warn(
              `Failed to close proxy: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          activeProxyHandle = null;
        }
      },
    });

    // Skip proxy startup unless we're in gateway mode
    // The proxy keeps the Node.js event loop alive, preventing CLI commands from exiting
    // The proxy will start automatically when the gateway runs
    if (!isGatewayMode()) {
      api.logger.info("Not in gateway mode — proxy will start when gateway runs");
      return;
    }

    // Start proxy in background WITHOUT blocking register()
    // CRITICAL: Do NOT await here - this was blocking model selection UI for 3+ seconds
    startProxyInBackground(api, apiKeys)
      .then(async () => {
        // Proxy started successfully - verify health
        const port = getProxyPort();
        const healthy = await waitForProxyHealth(port, 5000);
        if (!healthy) {
          api.logger.warn(`Proxy health check timed out, commands may not work immediately`);
        }
      })
      .catch((err) => {
        api.logger.error(
          `Failed to start ClawRouter proxy: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  },
};

export default plugin;

// Re-export for programmatic use
export { startProxy, getProxyPort } from "./proxy.js";
export type { ProxyOptions, ProxyHandle } from "./proxy.js";
export { clawrouterProvider } from "./provider.js";
export {
  OPENCLAW_MODELS,
  BLOCKRUN_MODELS,
  buildProviderModels,
  MODEL_ALIASES,
  resolveModelAlias,
  isAgenticModel,
  getAgenticModels,
  getModelContextWindow,
} from "./models.js";
export {
  route,
  DEFAULT_ROUTING_CONFIG,
  getFallbackChain,
  getFallbackChainFiltered,
  calculateModelCost,
} from "./router/index.js";
export type { RoutingDecision, RoutingConfig, Tier } from "./router/index.js";
export { logUsage } from "./logger.js";
export type { UsageEntry } from "./logger.js";
export { RequestDeduplicator } from "./dedup.js";
export type { CachedResponse } from "./dedup.js";
export { fetchWithRetry, isRetryable, DEFAULT_RETRY_CONFIG } from "./retry.js";
export type { RetryConfig } from "./retry.js";
export { getStats, formatStatsAscii, clearStats } from "./stats.js";
export type { DailyStats, AggregatedStats } from "./stats.js";
export {
  SessionStore,
  getSessionId,
  hashRequestContent,
  DEFAULT_SESSION_CONFIG,
} from "./session.js";
export type { SessionEntry, SessionConfig } from "./session.js";
export { ResponseCache } from "./response-cache.js";
export type { CachedLLMResponse, ResponseCacheConfig } from "./response-cache.js";
export { PARTNER_SERVICES, getPartnerService, buildPartnerTools } from "./partners/index.js";
export type { PartnerServiceDefinition, PartnerToolDefinition } from "./partners/index.js";
export {
  loadApiKeys,
  getConfiguredProviders,
  getApiKey,
  getProviderFromModel,
  resolveProviderAccess,
  hasOpenRouter,
  getAccessibleProviders,
  isModelAccessible,
} from "./api-keys.js";
export type { ApiKeysConfig, ProviderConfig } from "./api-keys.js";
export { refreshOpenRouterModels, resolveOpenRouterModelId, isOpenRouterCacheReady } from "./openrouter-models.js";
