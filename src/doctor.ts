/**
 * ClawRouter Doctor - Diagnostics
 *
 * Checks system state and provider configuration.
 */

import { platform, arch, freemem, totalmem } from "node:os";
import { getStats } from "./stats.js";
import { getProxyPort } from "./proxy.js";
import { VERSION } from "./version.js";
import { loadApiKeys, getConfiguredProviders, getAccessibleProviders } from "./api-keys.js";

interface DiagnosticsResult {
  version: string;
  os: string;
  arch: string;
  nodeVersion: string;
  memoryFree: string;
  memoryTotal: string;
  proxyPort: number;
  configuredProviders: string[];
  accessibleProviders: string[];
  proxyHealthy: boolean;
}

export async function runDiagnostics(): Promise<DiagnosticsResult> {
  const port = getProxyPort();
  const apiKeys = loadApiKeys();
  const configured = getConfiguredProviders(apiKeys);
  const accessible = getAccessibleProviders(apiKeys);

  let proxyHealthy = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    proxyHealthy = res.ok;
  } catch {
    // Proxy not running
  }

  return {
    version: VERSION,
    os: `${platform()} ${arch()}`,
    arch: arch(),
    nodeVersion: process.version,
    memoryFree: `${Math.round(freemem() / 1024 / 1024)}MB`,
    memoryTotal: `${Math.round(totalmem() / 1024 / 1024)}MB`,
    proxyPort: port,
    configuredProviders: configured,
    accessibleProviders: accessible,
    proxyHealthy,
  };
}

export function formatDiagnostics(diag: DiagnosticsResult): string {
  const lines = [
    `ClawRouter v${diag.version}`,
    `OS: ${diag.os}`,
    `Node: ${diag.nodeVersion}`,
    `Memory: ${diag.memoryFree} free / ${diag.memoryTotal} total`,
    `Proxy: port ${diag.proxyPort} (${diag.proxyHealthy ? "healthy" : "not running"})`,
    `Providers: ${diag.configuredProviders.join(", ") || "none configured"}`,
    `Accessible: ${diag.accessibleProviders.join(", ") || "none"}`,
  ];
  return lines.join("\n");
}
