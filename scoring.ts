import { score } from "@typesafe-ai/sdk";

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

export function extractAssistantText(message: {
  content?: readonly unknown[];
}): string {
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
