import assert from "node:assert/strict";
import test from "node:test";

import { createJevClient, resolveJevEnvironment } from "../main.ts";

test("resolves API key and base URL only from environment variables", () => {
  assert.deepEqual(resolveJevEnvironment({
    JEV_API_KEY: " jev-key ",
    TYPESAFE_API_KEY: "typesafe-key",
    TYPESAFE_BASE_URL: " https://openrouter.ai/api/ ",
  }), {
    apiKey: "jev-key",
    baseUrl: "https://openrouter.ai/api/",
  });
});

test("uses TYPESAFE_API_KEY when the compatibility key is blank", () => {
  assert.deepEqual(resolveJevEnvironment({
    JEV_API_KEY: "   ",
    TYPESAFE_API_KEY: " typesafe-key ",
  }), {
    apiKey: "typesafe-key",
    baseUrl: undefined,
  });
});

test("passes TYPESAFE_BASE_URL to the TypeSafe client", () => {
  const client = createJevClient({
    apiKey: "test-key",
    baseUrl: "https://openrouter.ai/api/",
  });

  assert.equal(client.baseURL, "https://openrouter.ai/api");
});
