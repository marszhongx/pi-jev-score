import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TypeSafeClient } from "@typesafe-ai/sdk";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONFIG_FILE_NAME = "pi-jev-score.json";

export interface JevConfig {
  apiKey?: string;
  baseUrl?: string;
}

interface LoadJevConfigOptions {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readConfigFile(agentDir: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, CONFIG_FILE_NAME), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function loadJevConfig(options: LoadJevConfigOptions = {}): JevConfig {
  const env = options.env ?? process.env;
  const file = readConfigFile(options.agentDir ?? getAgentDir());

  return {
    apiKey: nonBlankString(file.apiKey) ??
      nonBlankString(env.JEV_API_KEY) ??
      nonBlankString(env.TYPESAFE_API_KEY),
    baseUrl: nonBlankString(file.baseUrl) ?? nonBlankString(env.TYPESAFE_BASE_URL),
  };
}

export function createJevClient(config: JevConfig): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    timeout: 1_500,
    retry: {
      maxRetries: 1,
      backoffInitialMs: 150,
      backoffMaxMs: 400,
    },
    logLevel: "warn",
  });
}
