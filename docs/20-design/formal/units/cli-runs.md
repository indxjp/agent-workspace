# B-cli-runs

`Cli/Runs.lean` imports the SDK run model and captures every `aw runs` command's SDK dispatch,
start prompt/model parsing, output mode precedence, stream frame shape, typed failure exits,
SDK failure-class mapping, stderr line order, and SIGINT courtesy-interrupt behavior.
T0/T1/T2 theorems name the CLI implementation and
SDK guide sentences. A T4 witness records the current `runs wait` and `runs start --wait`
behavior: a failed or cancelled settled run prints its record and exits zero; the documented
outcome target calls for a failing exit. That target exit is inferred from the guide's
`0 success` rule; it is not directly specified for failed run resources.

The replay invokes the real public `main` export with a recording `CliIo` and fetch double.
The package's private `runCli` helper is not exported by `@indx-workspace/aw`, so importing it
from `tests/formal` would cross the declared package boundary. The in-test harness mirrors its
in-memory environment and exercises the same `main` function.

## Verification

The named `Vectors.CliRuns` target built and family-only generation produced eight vector files.
The real public CLI replay passed **41/41** cases, including generated dispatch, start mode,
prompt, output, flags, wait exit, typed failure, and stderr vectors. Twelve definition mutations
all failed named theorem builds: events dispatch, start conflict, wait secondary call, stdin dash,
model colon, raw precedence, done frame, failed wait exit, courtesy guard, JSONL page shape,
transport exit, and interrupted error order. Source bytes were restored, then the clean vector
build passed. The combined SDK/CLI `lake exe axioms` audit checked 1,563 declarations;
`lake exe imports` checked 32 model import edges; 28 CLI and 38 SDK citations resolved.
TypeScript typecheck, ESLint, and Prettier passed. An independent final pass killed six further
fresh definition mutations, restored source hashes, and repeated the clean CLI vector build and
**41/41** replay.

## Model limits

File reads, terminal signals, network requests, and stdout rendering are replayed against real
TypeScript; Lean models their observable decisions. The model does not reproduce terminal
width-dependent table padding or timer duration. The current versus target wait exit is a
finding for triage, not a product change in this unit. Generated command vectors check the first
HTTP request, while start-mode vectors and direct tests check the full wait/follow sequence.
The proposed `targetExit` in wait vectors is a model comparison and is intentionally not asserted
against the current CLI. The real suite checks a fresh courtesy-interrupt signal and a refused
courtesy request; it does not wait five seconds to measure the timeout itself.
