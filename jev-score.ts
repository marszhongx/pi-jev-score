import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  buildEvaluationRequest,
  extractAssistantText,
  normalizeJevScore,
  SCORE_DIMENSIONS,
  type EvaluationInput,
  type ResponseScore,
  type ScoreDimension,
} from "./scoring.ts";

const STATE_TYPE = "jev-score-state";
const STATUS_KEY = "jev-score";
const STATE_VERSION = 1;
const REQUEST_TIMEOUT_MS = 3_000;

interface StoredScore {
  version: typeof STATE_VERSION;
  timestamp: number;
  result: ResponseScore;
}

export interface JevScoreDependencies {
  evaluate(input: EvaluationInput, signal?: AbortSignal): Promise<ResponseScore>;
  isConfigured(): boolean;
  requestTimeoutMs?: number;
}

const dimensionLabels: Record<ScoreDimension, string> = {
  correctness: "Correctness",
  relevance: "Relevance",
  completeness: "Completeness",
  clarity: "Clarity",
};

function apiKey(): string | undefined {
  return process.env.JEV_API_KEY?.trim() || process.env.TYPESAFE_API_KEY?.trim() || undefined;
}

let client: TypeSafeClient | undefined;

async function evaluateWithJev(input: EvaluationInput, signal?: AbortSignal): Promise<ResponseScore> {
  client ??= new TypeSafeClient({
    apiKey: apiKey(),
    timeout: 1_500,
    retry: {
      maxRetries: 1,
      backoffInitialMs: 150,
      backoffMaxMs: 400,
    },
    logLevel: "warn",
  });

  const startedAt = Date.now();
  const response = await client.systemOne(buildEvaluationRequest(input), { signal });
  return normalizeJevScore(response, Date.now() - startedAt);
}

const defaultDependencies: JevScoreDependencies = {
  evaluate: evaluateWithJev,
  isConfigured: () => apiKey() !== undefined,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isResponseScore(value: unknown): value is ResponseScore {
  if (!isRecord(value) ||
    !isFiniteNumber(value.total) ||
    !isFiniteNumber(value.confidence) ||
    !isRecord(value.dimensions) ||
    typeof value.evaluatorModel !== "string" ||
    !isRecord(value.usage) ||
    !isFiniteNumber(value.usage.inputTokens) ||
    !isFiniteNumber(value.usage.outputTokens) ||
    !isFiniteNumber(value.latencyMs)) {
    return false;
  }

  const dimensions = value.dimensions;
  return SCORE_DIMENSIONS.every((name) => {
    const dimension = dimensions[name];
    return isRecord(dimension) &&
      isFiniteNumber(dimension.score) &&
      isFiniteNumber(dimension.confidence);
  });
}

function restoreScore(entries: readonly unknown[]): ResponseScore | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
    if (!isRecord(entry.data) || entry.data.version !== STATE_VERSION) return undefined;
    return isResponseScore(entry.data.result) ? entry.data.result : undefined;
  }
  return undefined;
}

function statusText(result: ResponseScore, ctx: ExtensionContext): string {
  const color = result.total >= 80 ? "success" : result.total >= 60 ? "warning" : "error";
  return ctx.ui.theme.fg(color, `JEV ${result.total.toFixed(1)}/100`);
}

function setReadyStatus(ctx: ExtensionContext, configured: boolean): void {
  const text = configured
    ? ctx.ui.theme.fg("dim", "JEV ready")
    : ctx.ui.theme.fg("warning", "JEV no API key");
  ctx.ui.setStatus(STATUS_KEY, text);
}

function formatDetails(result: ResponseScore): string {
  const dimensions = SCORE_DIMENSIONS.map((name) => {
    const value = result.dimensions[name];
    return `${dimensionLabels[name].padEnd(12)} ${value.score.toFixed(1)}/10`;
  });

  return [
    `JEV response score: ${result.total.toFixed(1)}/100`,
    ...dimensions,
    `Confidence   ${Math.round(result.confidence * 100)}%`,
    `Evaluator    ${result.evaluatorModel}`,
    `Latency      ${result.latencyMs}ms`,
  ].join("\n");
}

function lastFinalResponse(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const stopReason = message.stopReason;
    if (stopReason !== "stop" && stopReason !== "length") continue;
    const text = extractAssistantText(message);
    if (text) return text;
  }
  return "";
}

export function createJevScoreExtension(dependencies: JevScoreDependencies) {
  return function jevScoreExtension(pi: ExtensionAPI): void {
    let currentPrompt = "";
    let finalResponse = "";
    let latestScore: ResponseScore | undefined;
    let pendingRequest: AbortController | undefined;

    const restore = (ctx: ExtensionContext): void => {
      pendingRequest?.abort();
      pendingRequest = undefined;
      currentPrompt = "";
      finalResponse = "";
      latestScore = restoreScore(ctx.sessionManager.getBranch());
      if (latestScore) ctx.ui.setStatus(STATUS_KEY, statusText(latestScore, ctx));
      else setReadyStatus(ctx, dependencies.isConfigured());
    };

    pi.on("session_start", (_event, ctx) => restore(ctx));
    pi.on("session_tree", (_event, ctx) => restore(ctx));

    pi.on("before_agent_start", (event) => {
      currentPrompt = event.prompt.trim();
      finalResponse = "";
    });

    pi.on("agent_end", (event) => {
      const response = lastFinalResponse(event.messages);
      if (response) finalResponse = response;
    });

    pi.on("agent_settled", async (_event, ctx) => {
      const input = { prompt: currentPrompt, response: finalResponse };
      currentPrompt = "";
      finalResponse = "";

      if (!input.prompt || !input.response) return;
      if (!dependencies.isConfigured()) {
        setReadyStatus(ctx, false);
        return;
      }

      pendingRequest?.abort();
      const controller = new AbortController();
      pendingRequest = controller;
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, dependencies.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "JEV scoring…"));

      try {
        const result = await dependencies.evaluate(input, controller.signal);
        if (pendingRequest !== controller || controller.signal.aborted) return;
        latestScore = result;
        const state: StoredScore = {
          version: STATE_VERSION,
          timestamp: Date.now(),
          result,
        };
        pi.appendEntry(STATE_TYPE, state);
        ctx.ui.setStatus(STATUS_KEY, statusText(result, ctx));
      } catch {
        if (pendingRequest === controller && (timedOut || !controller.signal.aborted)) {
          ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "JEV unavailable"));
        }
      } finally {
        clearTimeout(deadline);
        if (pendingRequest === controller) pendingRequest = undefined;
      }
    });

    pi.on("session_shutdown", () => {
      pendingRequest?.abort();
      pendingRequest = undefined;
    });

    pi.registerCommand("jev-score", {
      description: "Show the latest JEV score for an AI response",
      handler: async (_args, ctx) => {
        if (latestScore) {
          ctx.ui.notify(formatDetails(latestScore), "info");
          return;
        }
        if (!dependencies.isConfigured()) {
          ctx.ui.notify(
            "JEV scoring is disabled. Set TYPESAFE_API_KEY (or JEV_API_KEY) and reload pi.",
            "warning",
          );
          return;
        }
        ctx.ui.notify("No AI response has been scored in this branch yet.", "info");
      },
    });
  };
}

export default createJevScoreExtension(defaultDependencies);
