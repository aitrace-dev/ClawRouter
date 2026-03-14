/**
 * ClawRouter ProviderPlugin for OpenClaw
 *
 * Registers ClawRouter as an LLM provider in OpenClaw.
 * Uses a local proxy to route requests to upstream provider APIs
 * (Google, Anthropic, OpenAI) using direct API keys from the environment.
 */

import type { ProviderPlugin } from "./types.js";
import { buildProviderModels } from "./models.js";
import type { ProxyHandle } from "./proxy.js";

/**
 * State for the running proxy (set when the plugin activates).
 */
let activeProxy: ProxyHandle | null = null;

/**
 * Update the proxy handle (called from index.ts when the proxy starts).
 */
export function setActiveProxy(proxy: ProxyHandle): void {
  activeProxy = proxy;
}

export function getActiveProxy(): ProxyHandle | null {
  return activeProxy;
}

/**
 * ClawRouter provider plugin definition.
 */
export const clawrouterProvider: ProviderPlugin = {
  id: "clawrouter",
  label: "ClawRouter",
  docsPath: "https://github.com/openclaw-ai/ClawRouter",
  aliases: ["cr"],
  envVars: ["GOOGLE_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],

  // Model definitions — dynamically set to proxy URL
  get models() {
    if (!activeProxy) {
      // Fallback: point to localhost default before proxy starts.
      // The proxy must be running for requests to succeed.
      return buildProviderModels("http://127.0.0.1:8402");
    }
    return buildProviderModels(activeProxy.baseUrl);
  },

  // No auth wizard needed — API keys are provided via environment variables
  // or OpenClaw config. The proxy reads them at startup and forwards
  // requests to the appropriate upstream provider.
  auth: [],
};
