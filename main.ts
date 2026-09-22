import { score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SCORE_DIMENSIONS = [
  "correctness",
  "relevance",
  "completeness",
  "clarity",
] as const;

export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

export interface EvaluationInput {
  prompt: string;
  response: string;
}

const QUALITY_RUBRICS = {
  correctness: [
    "Incorrect or misleading; contradicts the request or contains serious technical/factual errors.",
    "Mostly incorrect; a few useful elements, but major claims or instructions are unreliable.",
    "Partly correct; the core direction is plausible, with notable errors, unsupported claims, or uncertainty.",
    "Correct in the important details, with only minor issues that do not change the outcome.",
    "Fully correct, internally consistent, and appropriately honest about anything that cannot be verified.",
  ],
  relevance: [
    "Does not address the user's request.",
    "Touches the topic but is mostly off-target or dominated by irrelevant content.",
    "Addresses the main topic but includes substantial detours or misses the user's actual intent.",
    "Directly addresses the request with only minor unnecessary content.",
    "Precisely focused on the user's request; every material part helps answer it.",
  ],
  completeness: [
    "Provides no usable answer or omits essentially every requested deliverable.",
    "Provides a fragment of an answer while omitting most required work or essential caveats.",
    "Covers the main idea but leaves important requested items, evidence, or next steps unresolved.",
    "Covers all major requested items; only minor details or optional improvements are missing.",
    "Fully satisfies every requested deliverable with the necessary detail, evidence, and limitations.",
  ],
  clarity: [
    "Unintelligible, contradictory, or unusably disorganized.",
    "Hard to follow because of vague wording, poor structure, or excessive noise.",
    "Understandable but uneven, wordy, or insufficiently precise.",
    "Clear, well-structured, and appropriately concise with only minor presentation issues.",
    "Exceptionally clear, precise, well-organized, and concise for the task.",
  ],
} as const;

export function buildEvaluationRequest(input: EvaluationInput) {
  return {
    state: {
      user_request: input.prompt,
      assistant_response: input.response,
    },
    questions: {
      correctness: score(
        "How correct is the assistant response relative to the user request? Judge technical and factual soundness, internal consistency, and whether claims are appropriately qualified.",
        QUALITY_RUBRICS.correctness,
      ),
      relevance: score(
        "How directly and efficiently does the assistant response address the user's actual request?",
        QUALITY_RUBRICS.relevance,
      ),
      completeness: score(
        "How completely does the assistant response satisfy the requested deliverables, including necessary evidence, limitations, and next steps?",
        QUALITY_RUBRICS.completeness,
      ),
      clarity: score(
        "How clear, precise, well-structured, and appropriately concise is the assistant response?",
        QUALITY_RUBRICS.clarity,
      ),
    },
  };
}

export function extractAssistantText(message: { content?: readonly unknown[] }): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => {
      if (typeof part !== "object" || part === null) return false;
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string";
    })
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

interface JevDimensionAnswer {
  score: number;
  confidence: number;
}

export interface JevScoreResponse {
  model: string;
  answers: Record<ScoreDimension, JevDimensionAnswer>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface DimensionScore {
  score: number;
  confidence: number;
}

export interface ResponseScore {
  total: number;
  confidence: number;
  dimensions: Record<ScoreDimension, DimensionScore>;
  evaluatorModel: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  latencyMs: number;
}

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export function normalizeJevScore(response: JevScoreResponse, latencyMs: number): ResponseScore {
  const dimensions = Object.fromEntries(
    SCORE_DIMENSIONS.map((name) => {
      const answer = response.answers[name];
      return [name, {
        score: round((answer.score / 4) * 10, 1),
        confidence: round(answer.confidence, 3),
      }];
    }),
  ) as Record<ScoreDimension, DimensionScore>;

  const averageDimensionScore = SCORE_DIMENSIONS.reduce(
    (sum, name) => sum + dimensions[name].score,
    0,
  ) / SCORE_DIMENSIONS.length;
  const averageConfidence = SCORE_DIMENSIONS.reduce(
    (sum, name) => sum + dimensions[name].confidence,
    0,
  ) / SCORE_DIMENSIONS.length;

  return {
    total: round(averageDimensionScore * 10, 1),
    confidence: round(averageConfidence, 3),
    dimensions,
    evaluatorModel: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    latencyMs,
  };
}

export interface JevEnvironment {
  apiKey?: string;
  baseUrl?: string;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveJevEnvironment(env: NodeJS.ProcessEnv = process.env): JevEnvironment {
  return {
    apiKey: nonBlankString(env.JEV_API_KEY) ?? nonBlankString(env.TYPESAFE_API_KEY),
    baseUrl: nonBlankString(env.TYPESAFE_BASE_URL),
  };
}

export function createJevClient(environment: JevEnvironment): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: environment.apiKey,
    baseURL: environment.baseUrl,
    timeout: 1_500,
    retry: {
      maxRetries: 1,
      backoffInitialMs: 150,
      backoffMaxMs: 400,
    },
    logLevel: "warn",
  });
}

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

export function createDefaultJevDependencies(
  environment: JevEnvironment = resolveJevEnvironment(),
): JevScoreDependencies {
  let client: TypeSafeClient | undefined;

  return {
    isConfigured: () => environment.apiKey !== undefined,
    async evaluate(input, signal) {
      client ??= createJevClient(environment);
      const startedAt = Date.now();
      const response = await client.systemOne(buildEvaluationRequest(input), { signal });
      return normalizeJevScore(response, Date.now() - startedAt);
    },
  };
}

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

export default createJevScoreExtension(createDefaultJevDependencies());
