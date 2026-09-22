import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJevClient, loadJevConfig } from "../config.ts";

function withAgentDir(run: (agentDir: string) => void): void {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-jev-score-config-"));
  try {
    run(agentDir);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("extension config overrides API key and base URL environment variables", () => {
  withAgentDir((agentDir) => {
    writeFileSync(join(agentDir, "pi-jev-score.json"), JSON.stringify({
      apiKey: " file-key ",
      baseUrl: " https://score.example.test/api/ ",
    }));

    assert.deepEqual(loadJevConfig({
      agentDir,
      env: {
        JEV_API_KEY: "jev-env-key",
        TYPESAFE_API_KEY: "typesafe-env-key",
        TYPESAFE_BASE_URL: "https://env.example.test",
      },
    }), {
      apiKey: "file-key",
      baseUrl: "https://score.example.test/api/",
    });
  });
});

test("missing, blank, or malformed config safely falls back to environment variables", () => {
  withAgentDir((agentDir) => {
    const env = {
      JEV_API_KEY: "jev-env-key",
      TYPESAFE_API_KEY: "typesafe-env-key",
      TYPESAFE_BASE_URL: "https://env.example.test",
    };

    assert.deepEqual(loadJevConfig({ agentDir, env }), {
      apiKey: "jev-env-key",
      baseUrl: "https://env.example.test",
    });

    writeFileSync(join(agentDir, "pi-jev-score.json"), JSON.stringify({
      apiKey: "   ",
      baseUrl: "",
    }));
    assert.deepEqual(loadJevConfig({ agentDir, env }), {
      apiKey: "jev-env-key",
      baseUrl: "https://env.example.test",
    });

    writeFileSync(join(agentDir, "pi-jev-score.json"), "{not-json");
    assert.deepEqual(loadJevConfig({ agentDir, env }), {
      apiKey: "jev-env-key",
      baseUrl: "https://env.example.test",
    });
  });
});

test("passes the configured base URL to the TypeSafe client", () => {
  const client = createJevClient({
    apiKey: "test-key",
    baseUrl: "https://score.example.test/api/",
  });

  assert.equal(client.baseURL, "https://score.example.test/api");
});
