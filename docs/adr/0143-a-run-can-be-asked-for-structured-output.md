# ADR-0143 — A run can be asked for structured output

Status: accepted
Date: 2026-10-18
Decided by: issue #1282 (P3-0 of #1273)
Scope: `packages/contracts/src/runs.ts`, `packages/contracts/src/run-events.ts`, `packages/contracts/src/engines.ts`, `packages/contracts/src/engine-catalogue.ts`, `packages/engine-*/src/**`, `packages/sdk/src/resources/runs.ts`, `tests/gallery/harness/probes.ts`, `tests/gallery/*/benchmark.ts`

## Context

No ADR covers what a run returns. Today a run's answer exists only as `agent.message` frames in the
event stream. `RunResource` (`packages/contracts/src/runs.ts`) has no answer field, and
`StartRunRequestSchema` has no way to ask for a particular shape. The gallery's shared helper
(`tests/gallery/shared/run-answer.ts`) re-folds the message frames into text, and every gallery
backend then parses that text by hand; the tracker (#1273) counts one
such parser in each of the ten enterprise use cases.

The engine can already do this. The pinned Claude Agent SDK takes
`outputFormat: { type: 'json_schema'; schema }` (the Agent SDK surface research, R-01,
row 41), and its `error_max_structured_output_retries` result is already mapped to stop reason
`error` (`packages/core/src/claude-sdk-events.ts`). The gap is the public contract, and the gallery
harness names it as probe `run-output-schema` (`tests/gallery/harness/probes.ts`), asserted false by
`tests/gallery/probes.test.ts` and cited by ten `struct` benchmark cells.

Two facts shape the decision. ADR-0065 D3 says the platform refuses a requirement an engine cannot
honour, with a typed error, and never ignores it. ADR-0136 says the engine catalogue is the one
place an engine is described. The catalogue's `capabilities` has no `structuredOutput` key yet
(`EngineCapabilitiesSchema`, `packages/contracts/src/engines.ts`); the gateway's unrelated model flag
of the same name (`packages/gateway/src/types.ts`) describes a model, not an engine.

## Decision

This ADR decides the contract. It changes no code.

- **A request can carry a schema.** `StartRunRequest.outputSchema` is optional. It is a JSON Schema
  object whose root `type` is `"object"` and whose JSON serialisation is at most 32 KiB (32 768
  bytes of UTF-8). As elsewhere, the request schema stays strict, so an unknown key is still
  refused.
- **The schema dialect and its limits are pinned.** All of these are checked structurally at the
  contract boundary, with no JSON Schema library:
  - *Dialect:* JSON Schema **draft 2020-12**, the target the repository already gives
    `z.toJSONSchema` (`target: 'draft-2020-12'`). `$schema` is optional; if present it must be
    `https://json-schema.org/draft/2020-12/schema`.
  - *References:* only a local `$ref` of the form `#/$defs/<name>` that resolves inside the same
    schema. A remote or any other `$ref`, and `$dynamicRef`, are refused: the server and the engine
    never fetch anything on a caller's behalf.
  - *Depth:* at most **16** levels of nested schema objects, counted from the root (the root is level
    1; `properties`, `items`, `$defs`, `anyOf`/`oneOf`/`allOf` and `prefixItems` each descend one).
  - *Size:* the 32 KiB cap above stays.
  - *`pattern` and `format`:* **passed through, not refused.** `z.toJSONSchema` emits both for
    ordinary types (`z.email()`, `z.uuid()` and `z.iso.datetime()` each produce a `format` and a
    `pattern`), so refusing either would reject common schemas. The server never compiles or
    evaluates a `pattern` (no validator in v1), so a catastrophic one cannot stall the control
    plane. It is compiled only by the engine and its provider, and by the caller's own process when
    the SDK re-validates, so a hostile pattern costs the party that chose it. The 32 KiB and depth
    limits bound how many patterns a schema can carry.
  - *Refusal:* a schema outside these limits, or whose root is not an object type, is a `400`
    `invalid_body` at request time. Its message names the limit that failed, one of `root_type`,
    `size`, `dialect`, `ref` or `depth`, so a caller can branch on it. No new problem code is added.
- **A run resource carries the answer.** `RunResource.output` is
  `{ text: string; structured: unknown | null } | null`. It is `null` until the run's `status` is
  `completed`. `text` is the final assistant text. `structured` is the schema-conforming value when
  the request carried `outputSchema`, and `null` when it did not.
- **The stream carries it too.** The `agent.result` frame gains `output` with the same shape, so a
  streaming client gets the answer without re-reading the run. The frame reports what the engine
  produced for its turn; the run's outcome is still `run.status` (`AgentResultFrameSchema`), so a
  frame's `output` is authoritative only once the run is `completed`, and `RunResource.output` is the
  record.
- **A run that cannot meet its schema fails with a named code.** If the engine cannot produce a
  value that satisfies the schema (the SDK's `error_max_structured_output_retries`), the run ends
  `failed` with its existing stop reason `error`, and `output` stays `null`. A partial answer is
  never presented as a structured one. The code is `output_schema_unsatisfied`:
  - *Where it appears:* in the run's stored `error`, as `output_schema_unsatisfied: <safe message>`,
    the `<code>: <message>` form that `RunResource.error` already uses for
    `runtime_capacity_exhausted` and `run_preparation_failed`. `parseRunFailure`
    (`packages/contracts/src/runs.ts`) gains the code in `RunFailure.code`, so an SDK or HTTP client
    reads it from `run.error` without matching prose. The stop reason stays `error`, because the
    neutral stop-reason set is unchanged.
  - *HTTP and SDK shape:* there is no HTTP error status. `POST /api/agents/:id/runs` has already
    answered `202`, and `GET /api/runs/:id` answers `200` with `run.status: "failed"`. The SDK
    surfaces the failure through the existing `RunFailure` shape, and a caller branches on
    `code === 'output_schema_unsatisfied'`.
  - *Not retryable as is:* the same prompt and schema will likely fail again. The message is a fixed
    sentence and never repeats the model's text or the schema.
- **The engine enforces the schema; the server does not.** The engine receives the schema through
  its native option (the Claude Agent SDK's `outputFormat`) and returns a value that satisfies it.
  The server checks only what the contract states: the root type and the size limit. **No JSON Schema
  validator is added in v1.**
- **The SDK re-validates.** `@indx-workspace/sdk` parses `structured` with the caller's Zod schema
  and returns the typed value, so a caller who has a Zod schema gets a checked value and one who
  does not still gets the `unknown` the contract promises.
- **An engine that cannot do this refuses by name.** `structuredOutput` becomes a catalogue
  capability: a key of `EngineCapabilitiesSchema` in `packages/contracts/src/engines.ts`, set per
  engine in `ENGINE_CATALOGUE`. A run whose `outputSchema` is present on an engine whose
  `capabilities.structuredOutput` is `false` is refused at compose with the existing `422`
  `engine_capability_unsupported`, whose `details` names `structuredOutput`. No new problem code is
  added, and the schema is never silently dropped (ADR-0065 D3). Unlike `mcp`, `skills` and
  `subagents`, this is not decided at agent save: the request, not the agent, asks for it, so only
  run compose checks it.
- **Which engines say yes in v1.** Only `claude-agent-sdk` reports `structuredOutput: true`: it is
  the engine whose native `outputFormat` this ADR was written against. `openai-agents`, `pi` and
  `mastra` report `false`. Flipping one of them is the change that makes that adapter enforce the
  schema natively and adds its conformance test; this ADR does not promise it. #1284 sets the
  catalogue values together with the Claude adapter's use of `outputFormat`; it may confirm the
  three `false` entries but does not turn any of them on.
- **The probe is retired by the PR that adds the field.** The PR that adds the public field deletes
  probe `run-output-schema` from `tests/gallery/harness/probes.ts` and its assertion from
  `tests/gallery/probes.test.ts`, and moves the ten `struct` cells that cite it in
  `tests/gallery/*/benchmark.ts` in the same change. A field and a probe asserting it is absent must
  never be on `main` together, and a probe is never deleted without the field.
- **Not built in v1: server-side schema validation.** Validating `structured` against
  `outputSchema` on the server would need a JSON Schema library, a new runtime dependency.

## Alternatives considered

- **Validate `structured` on the server with a JSON Schema library.** Rejected for v1. It adds a
  dependency to the control plane for a check the engine already performs and the SDK repeats with
  the caller's own Zod schema. If an engine without enforcement is ever worth supporting, that is a
  new ADR, not a quiet addition.
- **A free-text-only `output`.** Rejected. It leaves the parser in every backend, which is the
  problem this ADR exists to remove.
- **Put the answer only in the event stream.** Rejected. A client that did not hold the stream open,
  or that reads the run later, would have to re-fold the frames, as every gallery backend does now.
  The resource must carry the answer, and the frame carries it for live clients.
- **Ignore `outputSchema` on an engine without the capability and return text.** Rejected. ADR-0065
  D3 forbids it, and a caller who asked for a shape would receive a different one without a signal.
- **A new problem code such as `output_schema_unsupported`.** Rejected. `engine_capability_unsupported`
  already means "the engine cannot honour what this request requires", and clients already branch on
  its `details` capability key.
- **Refuse `pattern` and `format` at the contract boundary.** Rejected. `z.toJSONSchema` emits both
  for `z.email()`, `z.uuid()` and `z.iso.datetime()`, so the SDK's own typed path would be refused.
  The server evaluates neither, so the ReDoS exposure is the engine's and the caller's.
- **Allow remote `$ref`.** Rejected. It makes the server or the engine fetch a caller-chosen URL.
- **No typed failure; leave callers to read `stopReason: error`.** Rejected. `error` also covers
  unrelated engine failures, and a caller that asked for a shape needs to tell "no conforming value"
  from "the engine broke".
- **Accept any JSON Schema root, or no size limit.** Rejected. The engine's option takes an object
  schema, and an unbounded schema is stored with the run and sent to the engine on every request.

## Consequences

- Each of the ten gallery backends can delete its answer parser once the contract and an engine
  implement this. Nothing is deleted by this ADR.
- `ENGINE_CAPABILITY_KEYS` (`packages/contracts/src/engines.ts`) is documented as the keys a saved
  agent can already be in breach of. It is amended to "or a run asks for", and `structuredOutput`
  joins it. ADR-0136's "Adding an engine" gains a step: set `structuredOutput` in the engine's
  catalogue entry. The `Record<EngineId, …>` type already refuses a missing entry.
- The capability does not exist yet. The implementing units add it; this ADR must not be read as
  saying `ENGINE_CATALOGUE` already has it. Until then `outputSchema` is not accepted, and the probe
  stays.
- #1283 (contract) implements the dialect checks, the five limit names and the
  `output_schema_unsatisfied` code in `RunFailure`. #1284 (engine) maps the SDK's
  `error_max_structured_output_retries` to that code and sets the catalogue values.
- The run row needs a nullable column for the schema and one for the output. That migration belongs
  to the implementing unit (#1283) and must be additive, since Cloud Run and Azure Container Apps run
  `migrate` at container start while an older revision still serves traffic.
- `output` is `null` for every run that is not `completed`, including runs that started before this
  ADR was implemented. A failed or cancelled run's partial text stays in the stream, not the resource.
- A `structured` value that the engine accepted but that fails the caller's Zod schema is an SDK
  error, not a platform error: the server does not know the Zod schema.
- Reversing this ADR means removing `outputSchema`, `output` and the `agent.result` field, dropping
  the two columns, the `structuredOutput` capability and the `output_schema_unsatisfied` code, and
  restoring probe `run-output-schema`
  and its ten cells together.
