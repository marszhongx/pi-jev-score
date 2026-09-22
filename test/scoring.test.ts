import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvaluationRequest,
  extractAssistantText,
  normalizeJevScore,
  SCORE_DIMENSIONS,
} from "../main.ts";

const answer = (score: number, confidence: number) => ({
  type: "score" as const,
  score,
  confidence,
  legend: {
    0: "unusable",
    1: "poor",
    2: "adequate",
    3: "good",
    4: "excellent",
  },
  probabilities: {
    0: 0.05,
    1: 0.1,
    2: 0.2,
    3: 0.25,
    4: 0.4,
  },
});

test("builds a JEV request from the user request and final response", () => {
  const request = buildEvaluationRequest({
    prompt: "Fix the parser and add tests.",
    response: "Implemented the parser fix and added three tests.",
  });

  assert.deepEqual(request.state, {
    user_request: "Fix the parser and add tests.",
    assistant_response: "Implemented the parser fix and added three tests.",
  });
  assert.deepEqual(Object.keys(request.questions), [...SCORE_DIMENSIONS]);
  for (const question of Object.values(request.questions)) {
    assert.equal(question.type, "score");
    assert.equal(question.criteria.length, 5);
  }
});

test("extracts only visible text from an assistant message", () => {
  assert.equal(extractAssistantText({
    content: [
      { type: "thinking", thinking: "private chain of thought" },
      { type: "text", text: "First paragraph." },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
      { type: "text", text: "Second paragraph." },
    ],
  }), "First paragraph.\n\nSecond paragraph.");
});

test("normalizes four JEV dimensions into an equal-weight 0-100 score", () => {
  const result = normalizeJevScore({
    model: "jev-test",
    answers: {
      correctness: answer(4, 0.9),
      relevance: answer(3, 0.8),
      completeness: answer(2, 0.7),
      clarity: answer(1, 0.6),
    },
    usage: { input_tokens: 120, output_tokens: 20 },
  }, 250);

  assert.deepEqual(result, {
    total: 62.5,
    confidence: 0.75,
    dimensions: {
      correctness: { score: 10, confidence: 0.9 },
      relevance: { score: 7.5, confidence: 0.8 },
      completeness: { score: 5, confidence: 0.7 },
      clarity: { score: 2.5, confidence: 0.6 },
    },
    evaluatorModel: "jev-test",
    usage: { inputTokens: 120, outputTokens: 20 },
    latencyMs: 250,
  });
});
