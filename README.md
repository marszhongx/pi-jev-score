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

JEV evaluates the user's request together with the final visible assistant response on four dimensions:

- **Correctness** — factual and technical soundness, internal consistency, and appropriate qualification.
- **Relevance** — how directly the response addresses the user's actual request.
- **Completeness** — whether requested deliverables, necessary evidence, limitations, and next steps are covered.
- **Clarity** — precision, structure, readability, and appropriate concision.

Each dimension uses a five-level rubric (0–4). JEV returns an expected score, which the extension scales to 0–10. The overall 0–100 score is the equal-weight average of the four dimensions. Confidence is the mean confidence reported for those dimensions.

The score is a semantic quality estimate, not proof that code changes, commands, links, or factual claims are correct.

## Requirements

- Node.js 20 or newer
- pi with extension support
- A TypeSafe API key from [TypeSafe](https://docs.typesafe.ai)

Set either environment variable:

```bash
export TYPESAFE_API_KEY="..."
# JEV_API_KEY is also accepted for compatibility with jev-router.
```

## Install

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

After changing the API key or extension source, run `/reload` in pi.

## Behavior

- Scores only the final visible text. Thinking blocks and tool calls are excluded.
- Waits until the agent run settles before evaluating the response.
- Stores the latest score in pi's session branch, so `/resume`, `/reload`, `/fork`, and `/tree` restore branch-appropriate state.
- Uses a three-second total deadline and fails open: missing credentials, timeouts, and JEV errors never alter or block the AI response.
- Shows `JEV no API key` when scoring is disabled and `JEV unavailable` when an evaluation fails.

## Privacy

To produce a score, this extension sends the **exact user request and final assistant response** to the TypeSafe API. Thinking blocks and tool call payloads are not sent by this extension. Do not enable it for content that must remain entirely local.

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
