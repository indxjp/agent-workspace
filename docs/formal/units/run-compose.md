# L-run-compose — run request composition

## Scope

`Behaviour/RunCompose.lean` models the server's start-body parser separately from the public
contract, workspace and project gates, existing-session checks and launch mode, model selection,
permission-derived tool denials, assigned-skill narrowing, read-only file grants, sandbox path
validation, and the four environment values derived by `compileRunRequest`. The model follows
the current implementation at each boundary and states stronger targets separately.

## Theorems and vectors

- T0 checks parser precedence, session reuse conditions, tool denials, and path constraints.
- T1 checks model precedence, absence of fallback, and compiled environment identity.
- T3 checks skill narrowing, denied tools, and refusal of provider master credentials.
- T4 gives concrete current/target witnesses for an archived session and an empty paired model.
- `parser.json` and the compose half of `sandbox.json` replay against the real app exports.
  `session.json` includes a PostgreSQL-backed `register()`/`openSession()` replay.
  `environment.json`, `tools.json` and the engine half of `sandbox.json` replay against
  `@agent-workspace/engine-claude-agent-sdk`: ENG-04 (#303) moved the compile step there, and
  ENG-04b (#325) moved the permission→tool mapping and the derivation of `CLAUDE_CONFIG_DIR` after
  it. Decision D-012 puts a replay that imports a *package* under `tests/formal/` and one that
  imports *application* code under the application's own `formal/`, so each vector file is replayed
  from wherever the code it is about now lives.
- **The vector expectations did not change, with one exception, and that is the point**: the
  refinement theorems this unit shares with `L-engine-compose` say the compile and the tool mapping
  produce what they produced, so a vector that had to be edited would have been a behaviour change
  rather than a move. The exception is `environment.json`'s `CLAUDE_CONFIG_DIR`, and it is a change
  to the *fixture* rather than to the function: the vector used to be able to name any configuration
  directory, and now it names the sandbox root the adapter derives one from
  (`/run/claude/tenant-a` → `/run/claude/tenant-a/.claude`).

## Findings

**Archived-session reuse.** The requested-session branch of `register.ts` checks the workspace,
agent, owner, and project, but never `session.status`. An archived session with a recorded Claude
session ID is returned with `resume: true`, so a new run can resume it. The
`archived_session_reuse_refused` theorem and `session.json` archived vector now pin the rejection
after PR #286.
The PostgreSQL replay archives a row and calls the real `openSession` composition.

**Empty paired model.** The server parser originally accepted a valid `modelConnectionId` paired
with `model: ""`, while `Contracts.Runs.startRunRequest` rejected a blank model. PR #285 fixed the
parser. The `server_rejects_empty_model_with_contract` theorem and parser vector now confirm
agreement at this boundary.

## Verification

Named Lean targets `AgentWorkspace.Theorems.Adversarial.RunCompose` and `Vectors.RunCompose`
build after restoration. Family vectors were generated and 25 real TypeScript differential tests
passed. The PostgreSQL `openSession` replay was skipped because `TEST_DATABASE_URL` is absent in
the focused run; it remains available to the service-backed full suite. Seven definition
mutations were killed by theorem failures: unknown parser key, blank prompt, archived-session
target refusal, model readiness, read-tool denial, sandbox path validation, and provider master-key
refusal. The original definition bytes were restored and rebuilt.
An independent pass found six further proof gaps. Direct T0/T1/T3 properties now require existing
session owner and project guards, stored tool denial, readable model credentials, and read-only
`KillShell` denial; the selected-skill theorem now states membership in both requested and assigned
lists. The six exact definition mutations fail the named theorem build. Source was restored and
the vector target rebuilt. The focused combined replay passed 109 tests, with five service-backed
tests skipped because `TEST_DATABASE_URL` was absent. Both relevant TypeScript configs and ESLint
passed. The combined `lake exe axioms` audit passed for 1,315 declarations, `lake exe imports`
passed for 30 edges, and 93 citations resolved.

## Limits

The model abstracts persistence and network I/O into Boolean gate outcomes. The session vector's
archived witness exercises real PostgreSQL only when `TEST_DATABASE_URL` is configured. The tool
and environment vectors cover the public deterministic functions, while model-provider lookup,
file materialization, and runtime launch are represented by their pure decisions, not full
external integrations. This unit does not claim cryptographic or filesystem isolation proofs.
