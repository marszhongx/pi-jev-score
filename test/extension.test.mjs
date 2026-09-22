import assert from "node:assert/strict";
import test from "node:test";

import { createJevScoreExtension } from "../main.ts";

const result = {
  total: 87.5,
  confidence: 0.82,
  dimensions: {
    correctness: { score: 9, confidence: 0.8 },
    relevance: { score: 10, confidence: 0.9 },
    completeness: { score: 8, confidence: 0.75 },
    clarity: { score: 8, confidence: 0.83 },
  },
  evaluatorModel: "jev-test",
  usage: { inputTokens: 100, outputTokens: 12 },
  latencyMs: 42,
};

function harness(evaluate, configured = true, initialEntries = [], requestTimeoutMs) {
  const handlers = new Map();
  const commands = new Map();
  const entries = [...initialEntries];
  const statuses = [];
  const notifications = [];
  const pi = {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
  };
  const ctx = {
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus: (key, text) => statuses.push({ key, text }),
      notify: (text, level) => notifications.push({ text, level }),
    },
    sessionManager: { getBranch: () => entries },
  };

  createJevScoreExtension({
    evaluate,
    isConfigured: () => configured,
    requestTimeoutMs,
  })(pi);

  const emit = async (name, event = { type: name }) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };

  return { commands, entries, statuses, notifications, emit, ctx };
}

const assistant = (content, stopReason = "stop") => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "test-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: Date.now(),
});

test("scores the final visible assistant response after the agent settles", async () => {
  const calls = [];
  const app = harness(async (input) => {
    calls.push(input);
    return result;
  });

  await app.emit("session_start", { type: "session_start", reason: "new" });
  await app.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "Fix the parser.",
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await app.emit("agent_end", {
    type: "agent_end",
    messages: [
      assistant([{ type: "text", text: "I will inspect it." }, { type: "toolCall", id: "1", name: "read", arguments: {} }], "toolUse"),
      assistant([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Fixed the parser and tests pass." }]),
    ],
  });
  await app.emit("agent_settled");

  assert.deepEqual(calls, [{
    prompt: "Fix the parser.",
    response: "Fixed the parser and tests pass.",
  }]);
  assert.equal(app.entries.length, 1);
  assert.equal(app.entries[0].customType, "jev-score-state");
  assert.equal(app.entries[0].data.result.total, 87.5);
  assert.match(app.statuses.at(-1).text, /JEV 87\.5\/100/);

  await app.commands.get("jev-score").handler("", app.ctx);
  assert.match(app.notifications.at(-1).text, /Correctness\s+9\.0\/10/);
  assert.match(app.notifications.at(-1).text, /Confidence\s+82%/);
});

test("restores the latest score from the active session branch", async () => {
  const saved = {
    type: "custom",
    customType: "jev-score-state",
    data: { version: 1, timestamp: 123, result },
  };
  const app = harness(async () => result, true, [saved]);

  await app.emit("session_start", { type: "session_start", reason: "resume" });

  assert.match(app.statuses.at(-1).text, /JEV 87\.5\/100/);
  await app.commands.get("jev-score").handler("", app.ctx);
  assert.match(app.notifications.at(-1).text, /JEV response score: 87\.5\/100/);
});

test("a scoring deadline reports unavailable instead of staying in progress", async () => {
  const app = harness((_input, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }), true, [], 5);

  await app.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "Answer me.",
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await app.emit("agent_end", {
    type: "agent_end",
    messages: [assistant([{ type: "text", text: "The answer." }])],
  });
  await app.emit("agent_settled");

  assert.match(app.statuses.at(-1).text, /JEV unavailable/);
  assert.equal(app.entries.length, 0);
});

test("JEV failures are fail-open and leave the AI response untouched", async () => {
  const app = harness(async () => {
    throw new Error("service unavailable");
  });

  await app.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "Answer me.",
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await app.emit("agent_end", {
    type: "agent_end",
    messages: [assistant([{ type: "text", text: "The answer." }])],
  });

  await assert.doesNotReject(app.emit("agent_settled"));
  assert.equal(app.entries.length, 0);
  assert.match(app.statuses.at(-1).text, /JEV unavailable/);
});
