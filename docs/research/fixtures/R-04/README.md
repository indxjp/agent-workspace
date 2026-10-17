# R-04 probe fixtures — OpenAI Responses API wire behavior

Companion to the R-04 research note (maintained privately). Everything that
note grades `verified` is produced here.

## The deliverables

| File | What it is |
| --- | --- |
| `extract-stream-event-types.mjs` | **Runnable.** Reads an installed `openai` package's `resources/responses/responses.d.ts` off disk, locates the `ResponseStreamEvent` union by name, resolves each member interface's `type:` discriminant, and prints the whole set with a count and a duplicate/unresolved check. Imports nothing but `node:fs`/`node:path`. |
| `stream-event-types.txt` | The output of the above, as run on 2026-09-05 against `openai@7.10.0`. This is where the note's event-taxonomy list comes from — copied out of this file, never retyped. |
| `extract-error-classes.mjs` | **Runnable.** Reads both SDKs' `core/error.d.ts` and prints each exception class with the base it extends, plus the three-way set comparison (both / OpenAI-only / Anthropic-only). Imports nothing but `node:fs`/`node:path`. |
| `error-classes.txt` | The output of the above, against `openai@7.10.0` and `@anthropic-ai/sdk@0.123.0`, run 2026-09-05. |
| `extract-interfaces.mjs` | **Runnable.** Prints named TypeScript declarations out of an installed `openai` package's `resources/responses/responses.d.ts` **verbatim**, with their real line numbers. Specifiers are dotted paths (`FunctionTool`, `ResponseInputItem.FunctionCallOutput`) because three different interfaces in that file are called `FunctionCallOutput`; matching on the bare name would pick the wrong one. Exits non-zero if a requested specifier does not resolve. Imports nothing but `node:fs`/`node:path`. |
| `interfaces.txt` | The output of the above with its default specifier set, against `openai@7.10.0`, run 2026-09-05. This is where the note's F4 `FunctionTool` and F6 `FunctionCallOutput` blocks come from. |
| `sdk-probe.md` | An **inert capture** — script plus its full raw output — of the executed probe. Part A reaches the real `https://api.openai.com` with a deliberately invalid key to capture OpenAI's own error envelope; Part B is a loopback stub that establishes what the client sends and how the client parses seven different SSE framings. |

## Why three of these are generated and one is a capture

`extract-*.mjs` are the generators, per [ADR-0016](../../../adr/0016-measured-numbers-do-not-live-in-prose.md) ("a measured number does not live in prose; it is emitted or it is absent"):
round 1 of this note transcribed the `ResponseStreamEvent` union by hand and shipped **eleven type
strings that do not exist in the SDK** and a member count of 56 against an actual 58, and
transcribed a set difference against R-03's exception list that was wrong in both directions.
Neither list is written down in the note any more; both are copied out of the `.txt` beside the
script that produced them.

`extract-interfaces.mjs` is round 3's addition and has the same cause. Round 1 also hand-typed two
whole `interface` blocks — `FunctionTool` and `ResponseInputItem.FunctionCallOutput` — and round 2
audited the two *lists* for verbatimness while leaving those blocks alone. Between them they
dropped six declared fields with no elision marker, beside a sentence asserting the complete
interface had been read, and renamed the three element types of `FunctionCallOutput.output` to
three different interfaces that also exist in the same file. Neither block is typed in the note any
more.

Those three scripts are committed as tracked, runnable `.mjs` because they can be: they read files
and import no package. `sdk-probe.md` cannot be, because it imports `openai` — and
[ADR-0032](../../../adr/0032-an-unresolvable-bare-specifier-inside-a-research-fixture-is-a-verdict-not-a-refusal.md) clause 1
requires every package a *committed, executable* fixture imports to be named in the literal
`PACKAGES_A_FIXTURE_INSTALLS_FOR_ITSELF` inside `tests/no-sdk-import.test.ts`. That file is shared
CI infrastructure outside this note's owns globs (the R-04 note and
`docs/research/fixtures/R-04/**`), so the probe stays an inert Markdown capture and the package it
needs is named here, in the script's own install comment, and in the note's citations instead.
Landing the OpenAI provider (W4-GW-04) declares `openai` as a real dependency and makes a tracked
`.mjs` possible without touching that gate — filed as a declared gap on this note's PR.

## Packages, and the freshness check

`openai@7.10.0` — `npm view openai version` reported `7.10.0` as latest on 2026-09-05, the
retrieval date of every type-contract claim in the note. `@anthropic-ai/sdk@0.123.0` is the
version R-03 read, pinned so the exception-class comparison is against R-03's own evidence rather
than a newer package.

## Reproducing

```sh
mkdir probe-r04 && cd probe-r04
npm init -y
npm install openai@7.10.0 @anthropic-ai/sdk@0.123.0
node <path-to-this-dir>/extract-stream-event-types.mjs ./node_modules/openai
node <path-to-this-dir>/extract-error-classes.mjs ./node_modules/openai ./node_modules/@anthropic-ai/sdk
node <path-to-this-dir>/extract-interfaces.mjs ./node_modules/openai
# and, for sdk-probe.md, copy the script out of its fenced block first:
node sdk-probe.mjs
```

All four were re-run on 2026-09-05 in a scratch install made the same day, and all four reproduce:
each extractor's output `diff`s clean against its committed `.txt`, and the probe script lifted out
of `sdk-probe.md`'s fenced block produces output that `diff`s clean against that file's own
```` ```text ```` block — the live 401 from `api.openai.com` included.

The three extractors are offline and fully deterministic. `sdk-probe.mjs` needs outbound HTTPS to
`api.openai.com` for Part A and nothing else; it needs no credentials, calls no model, and Part B
never leaves loopback. `sdk-probe.md` lists the handful of bytes in its output that do vary.
