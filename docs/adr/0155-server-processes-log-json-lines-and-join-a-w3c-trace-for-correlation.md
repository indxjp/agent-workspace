# ADR-0155 — Server processes log JSON lines and join a W3C trace for correlation only

Status: accepted
Date: 2026-10-19
Decided by: engineering audit task W2-10 (finding F-04, #1356); records what #1474 and #1475 landed
Amended: 2026-10-19, owner decision D10: the runner and the gateway export OpenTelemetry spans (see "Amendment D10")
Scope: `packages/core/src/telemetry/**`, `apps/runner/src/{index,server,run-handler}.ts`, `packages/gateway/src/{index,server,router,vercel-function}.ts`, `apps/web/server/telemetry/**`, `apps/web/server/composition/wiring/run-launcher.ts`, the `no-console` block in `eslint.config.mjs`
Related: [ADR-0144](0144-inbound-triggers-start-runs-from-a-webhook-or-a-schedule.md) (the trigger secret is redacted from spans); [the operations runbook](../operations/runbook.md) "Telemetry, retention, and privacy"

## Context

Finding F-04 of the engineering audit: the web server, the runner and the gateway each wrote free
text to `console` or `process.stdout`, in three formats, with error messages interpolated into the
line. A provider or database error could put a URL, a token or a caller's text into a log, and a
failed model call in the gateway could not be matched to the run that made it.

W2-10 added a logging port to `packages/core`; #1474 moved the gateway and the runner's trace
forwarding onto it, and #1475 moved the web server code onto it (its `no-console` suppressions went
from 100 to 0). This record states the rules those changes follow, so the next process that logs
uses the same ones.

## Decision

**One logger port.** `@agent-workspace/core/telemetry` exports `Logger` (`info`, `warn`, `error`,
`child`) and `createJsonLogger({ service })`. Production code logs through a `Logger` it was given or
a module-level one an entry point created: `service` is `web` (`apps/web/server/telemetry/logger.ts`
and the composition root), `runner` (`apps/runner/src/index.ts`, `server.ts`) or `gateway`
(`packages/gateway/src/index.ts`, `server.ts`, `vercel-function.ts`). The ESLint `no-console` rule
covers `apps/web/server/**`, `apps/web/app/**`, `apps/runner/src/**` and `packages/gateway/src/**`,
with no suppression left.

**Line format.** One JSON object per line, on stdout for `info` and stderr for `warn` and `error`.
The fixed keys `time` (ISO 8601), `level`, `service` and `msg` come first and a field cannot
overwrite them; the caller's fields follow. A `child(fields)` logger binds fields such as `runId` or
`traceId` to every line. A sink that throws is ignored: logging never crashes what it logs. There is
no `debug` level.

**Redaction applies to fields, not to `msg`.** Every string field value, at any depth up to 4, goes
through `redacted()`: a URL becomes `[url]`, an unbroken token of 32 or more `[A-Za-z0-9_-]`
characters that is not a UUID becomes `[redacted]`, and the result is cut to 200 characters. An
`Error` becomes `{ name, message, cause }` with the message redacted and no stack. `traceId` and
`spanId` are kept when they are 16 or 32 lowercase hex characters, which the token rule would
otherwise mask. Functions, symbols and bigints are dropped. `msg` is written as given, so **a message
is a fixed string that may name ids, and never carries untrusted text**: an error, a provider reply or
a caller's input goes in a field (`{ error }`), where it is redacted.

**Trace context is W3C `traceparent`, parsed strictly.** `parseTraceparent` accepts lowercase hex
only, rejects all-zero ids and version `ff`, requires exactly four fields for version `00`, and caps
the header at 512 characters; anything else is "no trace", never an error and never echoed.
`traceHeaders(traceparent, tracestate)` returns the headers to forward: the `traceparent` rebuilt
from its parsed fields as version `00`, and `tracestate` only when it is 1–512 printable ASCII
characters and the `traceparent` was valid.

**Who joins the trace.**

- The web control plane adds the active span's `traceparent` to its runtime requests
  (`activeTraceHeaders()` in `run-launcher.ts`). It is empty unless OpenTelemetry is configured.
- The runner adopts a valid incoming `traceparent` and binds its `traceId` to that request's log
  lines. For `/run` it adds the validated trace headers to the engine's `ANTHROPIC_CUSTOM_HEADERS`,
  extending a value the run already set, so the Claude CLI sends them on every model call to the
  gateway. With tracing on, the forwarded `traceparent` names the runner's `/run` span as the parent
  (Amendment D10); with it off, the caller's trace is forwarded unchanged.
- The gateway calls `adoptTrace` at its edge (the Node server and the Vercel Function): a valid
  `traceparent` is kept, anything else is replaced by a fresh random, sampled trace and its
  `tracestate` dropped. `requestLogger` binds the `traceId` to every line for that request, including usage
  settlement failures. Provider adapters forward allow-listed headers only, so trace headers do not
  go upstream.

**A trace id is for correlation only.** The gateway's direct caller is the agent sandbox, whose code
can send any trace id it likes, and the runner passes on whatever its caller sent. An adopted id joins
log lines; it is never used for authorisation, tenancy, billing, deduplication or anything else.

**OpenTelemetry is on only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.** The web app depends on
`@opentelemetry/api`, `@opentelemetry/sdk-node` and `@opentelemetry/exporter-trace-otlp-http`. It
starts a `NodeSDK` only when that variable is set, exports the Next.js spans and one `agent.run`
span per run, and redacts the trigger secret from span names and attributes before export
(ADR-0144). Since Amendment D10 (below) the runner and the gateway do the same. No
auto-instrumentation package is installed anywhere. Logs are not exported over OTLP; they are JSON lines for the
platform's log collector.

## Alternatives considered

- **A logging library (pino, winston).** Each is a new dependency for a format that is about 100
  lines here, and none redacts by default. Rejected while the port is this small; the `Logger`
  interface lets one replace `createJsonLogger` behind it later.
- **Redacting `msg` too.** It would mask ids that are useful in a message and still hide nothing a
  disciplined message does not already avoid. The rule "untrusted text goes in a field" keeps one
  redaction path and makes the mistake visible in review.
- **Treating a forwarded trace id as trustworthy.** Both the runner and the gateway receive it from
  code they do not control; trusting it would let a sandbox attach its calls to another run's trace
  in anything that reads the id for more than correlation.
- **Adding the OpenTelemetry SDK and auto-instrumentation to the runner and the gateway now.** That
  is a new runtime dependency in two deployables, which the dependency rules leave to the owner.
  Propagating `traceparent` and logging the `traceId` gives correlation without it. The owner
  approved the SDK, without auto-instrumentation, in D10; see the amendment.

## Consequences

- A log pipeline parses JSON; matching the old free-text lines no longer works (changelog fragments
  `gateway-json-logs` and `web-structured-logs`).
- A message that interpolates an error or caller text is a defect the logger cannot catch. Reviews
  and tests check for it; `msg` is not redacted.
- Open items:
  - **Auto-instrumentation anywhere** (HTTP clients, `pg`) still needs an owner decision; D10
    approved explicit spans only.
  - **A gateway server span ends when the response headers are written**, not when a streamed body
    finishes, so for a streamed model call its duration is the time to the first byte.
  - **The runner records no tool-call spans.** Tools run inside the engine's process, and the runner
    has no single place where a tool call starts and ends.
  - **Only the Claude engine forwards the trace to the gateway**, because `ANTHROPIC_CUSTOM_HEADERS`
    is the Claude CLI's variable. The Mastra, OpenAI Agents and Pi engines need a header hook in
    their model clients; until then their gateway lines carry a fresh trace id.
  - **`apps/web/proxy.ts` still calls `console.warn`** for a refused cross-origin write. The file is
    outside the `no-console` glob.
  - **Browser code is not covered.** `apps/web/components/**` and `apps/web/lib/**` are outside the
    `no-console` glob, and client components have no logger port. They have no `console` calls today,
    but nothing stops one being added.
  - **`packages/core/src/db`** writes plain text (`client.ts` on a dropped pool connection,
    `migrate.ts` and `seed.ts` as CLI output). These are outside the `no-console` glob.
  - The `tracestate` check is a bounded printable-ASCII check, not the full W3C list-member grammar.
- Reversing this record means choosing a new line format and redaction rule for three services at
  once; the `Logger` port is the seam for that.

## Amendment D10 (2026-10-19): the runner and the gateway export spans

The owner approved the OpenTelemetry SDK for the runner and the gateway (decision D10) on the web
app's terms: the same three packages and versions, the same switch, and no auto-instrumentation.

- **Off unless configured.** `startTracing` in `@agent-workspace/core/tracing` returns `null` when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is unset and imports neither `@opentelemetry/sdk-node` nor the
  exporter; spans are then the API's no-ops. When it is set, a `NodeSDK` exports to
  `<endpoint>/v1/traces` through a batch processor. The service name is `OTEL_SERVICE_NAME`, else
  `agent-workspace-runner` or `agent-workspace-gateway`. The runner's `main` and the gateway's Node
  entry start it before listening and flush it on shutdown; the Vercel Function starts it once per
  instance, on its first request. Tracing is optional everywhere: if the SDK fails to start,
  `startTracing` logs one error naming only the collector's host and returns `null`, and the process
  serves without spans.
- **The Vercel Function flushes after every response.** An instance may be frozen once it answers,
  so the batch timer cannot be relied on. The function calls the batch processor's `forceFlush`
  before it returns, bounded at 200 ms, so a slow collector delays a response by at most that much
  and spans past the bound may still be lost. The platform's `waitUntil` would move the flush off
  the response path, but it needs `@vercel/functions`, a new dependency D10 did not cover.
- **One server span per request, in the adopted trace.** The span's parent is built from the
  `traceparent` the process already adopted, so its trace id is the `traceId` on the request's log
  lines. The runner wraps `POST /run` (and `/invocations`); the gateway wraps every request after
  `adoptTrace`. A runner request that arrived without a trace logs the span's trace id instead.
- **Children.** The runner hands the engine its own span as the `traceparent` parent, so a Claude
  engine's gateway spans nest under the run. The gateway records one CLIENT span per model call
  around the router's provider call: `chat` for `/v1/messages`, `/v1/responses` and
  `/v1/chat/completions`, and `count_tokens`.
- **Attributes are an allow-list set in code.** Server spans carry `http.request.method`,
  `http.route` (only when the path is one of the router's fixed routes) and
  `http.response.status_code`. Model spans carry `gen_ai.operation.name`, `gen_ai.provider.name`
  (the run's provider id), `gen_ai.request.model` (caller text, so passed through `redacted()` like a
  log field, with the run's credential masked as well) and the upstream status. No URL, header, body, prompt, reply, credential or error
  message becomes an attribute; a thrown error only sets the span status. The web redactor
  (`redact-span.ts`) is not reused: it removes the `/fire/<secret>` path segment from framework spans
  that carry URLs, and these spans carry no URL.
- **A fresh gateway trace is sampled** (flags `01`): the gateway is its root, and the default
  parent-based sampler would otherwise drop its spans. An adopted trace keeps its caller's flag.
