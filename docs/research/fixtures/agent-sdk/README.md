# R-01 probe fixtures — `@anthropic-ai/claude-agent-sdk`

Companion to the R-01 research note (maintained privately).

Every row in that note graded `verified (probe — executed)` was produced by one of the
scripts here. They are committed so the claims can be re-run and audited by someone other
than their author, and so the contract artefact the planned `sdk-surface` CI gate reads can
be regenerated rather than trusted.

| File | What it establishes |
| --- | --- |
| `extract-options.mjs` | **Generates `docs/research/R-01-options.json`.** Reads every `Options` member — name, optionality, type — and the `query()` signature out of the shipped `sdk.d.ts`. |
| `probe-1-session-store.mjs` | Negative control. Points `CLAUDE_CONFIG_DIR` at a fresh directory with no credentials; the run fails at login before reaching the model. Nothing downstream of the model is evidence from this probe. |
| `probe-2-session-paths.mjs` | Where session state lands by default (`$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>.jsonl`), the `system/init` field set, the 17 bundled skills under `settingSources: []`, and the `InMemorySessionStore` dual-write. |
| `probe-3-project-key.mjs` | That `CLAUDE_CODE_PROJECT_DIR_NAME` — not an `Options.projectKey`, which does not exist — is what sets `SessionKey.projectKey`. Wraps `store.append` to capture the key actually passed. |

## Reproducing

```
mkdir probe-r01 && cd probe-r01
npm install @anthropic-ai/claude-agent-sdk@0.3.258
node <path-to-this-dir>/extract-options.mjs        # writes options.json
diff options.json <repo>/docs/research/R-01-options.json   # must be empty
```

`extract-options.mjs` honours `SDK_DTS` and `SDK_PKG` if the SDK lives somewhere other than
`./node_modules/@anthropic-ai/claude-agent-sdk`. The `diff` being empty is the check that
matters: if it is not, either the SDK version moved or the artefact was hand-edited, and
**the artefact is wrong, not the generator** — nothing in `options.json` is written by hand.

The three `probe-*.mjs` scripts need working Claude Code credentials and make **live API
calls that cost money**. `probe-3` copies the operator's real credentials into a scratch
config directory in order to test a relocated `CLAUDE_CONFIG_DIR`; read it before running it.

## Why the probe *outputs* are not committed here

`init.json` and `result.json` from probe 2 are quoted in the note where they are cited, but
the raw files are deliberately absent. They are a dump of the operator's live session and
carry host-specific and account-specific data — absolute home-directory paths, the local
messaging socket path, and the full tool list of whatever MCP servers that operator happened
to have connected. None of that is evidence about the SDK, and committing it would publish
one contributor's environment into the repository.

What the note quotes from them is the SDK-side content: the 25 `system/init` field names,
`claude_code_version`, `apiKeySource: "none"`, the 17 bundled skill names, `total_cost_usd`
and the two `modelUsage` keys. Re-running `probe-2-session-paths.mjs` regenerates both files
locally for anyone who wants to check a quotation in full.

## Provenance

`documented` / `verified (type contract)` / `verified (probe — executed)` are used here with
the meanings given in the note's Decisions-table legend, which match the sibling note R-03.
The extractor is not a probe: it reads a `.d.ts`, so everything it produces is
**verified (type contract)**, and `R-01-options.json` should be read as a type-contract
artefact, not as observed runtime behaviour.

Retrieved 2026-09-03 against `@anthropic-ai/claude-agent-sdk@0.3.258`
(`claudeCodeVersion` 2.1.258), Node v24.19.0, Windows 11, one host.
