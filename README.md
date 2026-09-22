# pi-jev-score

A [pi](https://github.com/earendil-works/pi-mono) extension that uses TypeSafe JEV (`System One`) to score the final text of each AI response.

After a response completes, the footer status shows its overall score:

```text
JEV 87.5/100
```

Run `/jev-score` to inspect the latest result:

```text
JEV response score: 87.5/100
Correctness  9.0/10
Relevance    10.0/10
Completeness 8.0/10
Clarity      8.0/10
Confidence   82%
Evaluator    jev-latest
Latency      412ms
```

## How scoring works

### Data flow

```text
user submits a prompt
  → before_agent_start captures the expanded text prompt
  → pi runs the model and any tools
  → agent_end finds the last completed assistant message
  → only visible text blocks are extracted
  → agent_settled sends the request/response pair to JEV
  → the result is normalized, persisted, and shown in the footer
```

The final response extractor searches backward for the last assistant message whose stop reason is `stop` or `length`. It joins its `text` blocks with blank lines and excludes:

- thinking blocks;
- tool calls and tool arguments;
- tool results;
- earlier assistant messages from the tool loop.

The extension does not send the system prompt, conversation history, attached images, or pi session metadata.

### JEV request

For example, if the user prompt is:

```text
What is 2 + 2? Reply with only the number.
```

and the final assistant response is:

```text
4
```

the extension constructs the following `System One` request. The TypeSafe SDK adds `model: "jev-latest"` when serializing it:

```json
{
  "state": {
    "user_request": "What is 2 + 2? Reply with only the number.",
    "assistant_response": "4"
  },
  "questions": {
    "correctness": {
      "type": "score",
      "instructions": "How correct is the assistant response relative to the user request? Judge technical and factual soundness, internal consistency, and whether claims are appropriately qualified.",
      "criteria": [
        "Incorrect or misleading; contradicts the request or contains serious technical/factual errors.",
        "Mostly incorrect; a few useful elements, but major claims or instructions are unreliable.",
        "Partly correct; the core direction is plausible, with notable errors, unsupported claims, or uncertainty.",
        "Correct in the important details, with only minor issues that do not change the outcome.",
        "Fully correct, internally consistent, and appropriately honest about anything that cannot be verified."
      ]
    },
    "relevance": {
      "type": "score",
      "instructions": "How directly and efficiently does the assistant response address the user's actual request?",
      "criteria": [
        "Does not address the user's request.",
        "Touches the topic but is mostly off-target or dominated by irrelevant content.",
        "Addresses the main topic but includes substantial detours or misses the user's actual intent.",
        "Directly addresses the request with only minor unnecessary content.",
        "Precisely focused on the user's request; every material part helps answer it."
      ]
    },
    "completeness": {
      "type": "score",
      "instructions": "How completely does the assistant response satisfy the requested deliverables, including necessary evidence, limitations, and next steps?",
      "criteria": [
        "Provides no usable answer or omits essentially every requested deliverable.",
        "Provides a fragment of an answer while omitting most required work or essential caveats.",
        "Covers the main idea but leaves important requested items, evidence, or next steps unresolved.",
        "Covers all major requested items; only minor details or optional improvements are missing.",
        "Fully satisfies every requested deliverable with the necessary detail, evidence, and limitations."
      ]
    },
    "clarity": {
      "type": "score",
      "instructions": "How clear, precise, well-structured, and appropriately concise is the assistant response?",
      "criteria": [
        "Unintelligible, contradictory, or unusably disorganized.",
        "Hard to follow because of vague wording, poor structure, or excessive noise.",
        "Understandable but uneven, wordy, or insufficiently precise.",
        "Clear, well-structured, and appropriately concise with only minor presentation issues.",
        "Exceptionally clear, precise, well-organized, and concise for the task."
      ]
    }
  },
  "model": "jev-latest"
}
```

The request is sent to `POST <baseUrl>/v1/systemone`; `baseUrl` defaults to `https://api.typesafe.ai`. The API key is carried in the HTTP `Authorization` header and is not included in the JSON body.

### Score construction

JEV returns an expected `score` from 0 to 4 for each dimension, plus `confidence`, `probabilities`, and the rubric `legend`. The extension keeps the score and confidence and normalizes them as follows:

```text
dimension score (0–10) = JEV score / 4 × 10
overall score (0–100)  = mean of four dimension scores × 10
overall confidence      = mean of four dimension confidences
```

The four equal-weight dimensions are:

- **Correctness** — factual and technical soundness, internal consistency, and appropriate qualification.
- **Relevance** — how directly the response addresses the user's actual request.
- **Completeness** — whether requested deliverables, necessary evidence, limitations, and next steps are covered.
- **Clarity** — precision, structure, readability, and appropriate concision.

A normalized result looks like this:

```json
{
  "total": 100,
  "confidence": 0.998,
  "dimensions": {
    "correctness": { "score": 10, "confidence": 1 },
    "relevance": { "score": 10, "confidence": 1 },
    "completeness": { "score": 10, "confidence": 0.99 },
    "clarity": { "score": 10, "confidence": 1 }
  },
  "evaluatorModel": "jev-1.13.0",
  "usage": {
    "inputTokens": 851,
    "outputTokens": 64
  },
  "latencyMs": 725
}
```

The extension persists this result as a `jev-score-state` custom session entry. Custom entries do not enter the model context. This enables branch-aware restoration after `/resume`, `/reload`, `/fork`, or `/tree`.

The score is a semantic quality estimate, not proof that code changes, commands, links, or factual claims are correct.

## Requirements

- Node.js 20 or newer
- pi with extension support
- A TypeSafe API key from [TypeSafe](https://docs.typesafe.ai)

## Configuration

Create `~/.pi/agent/pi-jev-score.json`:

```json
{
  "apiKey": "...",
  "baseUrl": "https://api.typesafe.ai"
}
```

When `PI_CODING_AGENT_DIR` is set, place the file in that directory instead. Because the file contains a credential, restrict its permissions:

```bash
chmod 600 ~/.pi/agent/pi-jev-score.json
```

Both fields are optional. Non-empty values in the config file take precedence over environment variables. The fallback variables are:

```bash
export TYPESAFE_API_KEY="..."                 # JEV_API_KEY is also accepted
export TYPESAFE_BASE_URL="https://api.typesafe.ai"
```

If `baseUrl` is omitted everywhere, the TypeSafe SDK default (`https://api.typesafe.ai`) is used. Run `/reload` after changing the config file or environment.

### OpenRouter

OpenRouter exposes a TypeSafe SDK-compatible System One endpoint. To use [Jev Latest on OpenRouter](https://openrouter.ai/~typesafe/jev-latest), configure:

```json
{
  "apiKey": "sk-or-v1-...",
  "baseUrl": "https://openrouter.ai/api"
}
```

The SDK appends `/v1/systemone`, so the request goes to:

```text
https://openrouter.ai/api/v1/systemone
```

Do **not** use the model page URL (`https://openrouter.ai/~typesafe/jev-latest`) as `baseUrl`, and do not include `/v1/systemone` yourself. The extension uses the SDK default model ID `jev-latest`, which OpenRouter maps to its `~typesafe/jev-latest` alias. Requests are billed to the OpenRouter account associated with the configured key.

The equivalent environment configuration is:

```bash
export TYPESAFE_API_KEY="$OPENROUTER_API_KEY"
export TYPESAFE_BASE_URL="https://openrouter.ai/api"
```

## Install

Install the published package:

```bash
pi install npm:pi-jev-score
```

Or install directly from GitHub:

```bash
pi install git:github.com/marszhongx/pi-jev-score
```

From a local checkout:

```bash
npm install
pi install /absolute/path/to/pi-jev-score
```

Or try it without installing:

```bash
npm install
pi -e ./jev-score.ts
```

After changing the configuration or extension source, run `/reload` in pi.

## Behavior

- Scores only the final visible text. Thinking blocks and tool calls are excluded.
- Waits until the agent run settles before evaluating the response.
- Stores the latest score in pi's session branch, so `/resume`, `/reload`, `/fork`, and `/tree` restore branch-appropriate state.
- Uses a three-second total deadline and fails open: missing credentials, timeouts, and JEV errors never alter or block the AI response.
- Shows `JEV no API key` when scoring is disabled and `JEV unavailable` when an evaluation fails.

## Privacy

To produce a score, this extension sends the **exact user request and final assistant response** to the configured TypeSafe-compatible `baseUrl`. Thinking blocks and tool call payloads are not sent by this extension. The API key is stored as plaintext when placed in `pi-jev-score.json`, so keep that file private and do not commit it. Do not enable scoring for content that must remain entirely local.

## Development

```bash
npm test
npm run typecheck
npm pack --dry-run
```

The test suite covers request construction, visible-text extraction, score normalization, lifecycle behavior, session restoration, deadlines, and fail-open handling.

## Inspiration

- [`gargpratyush/jev-router`](https://github.com/gargpratyush/jev-router) — JEV SDK integration, bounded requests, and fail-open behavior.
- [`that-lucas/pi-response-stats`](https://github.com/that-lucas/pi-response-stats) — pi lifecycle tracking, status display, and branch-aware persistence.

## License

MIT
