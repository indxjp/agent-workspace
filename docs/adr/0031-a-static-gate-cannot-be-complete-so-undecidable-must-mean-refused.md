# ADR-0031 — A static gate over a dynamic language cannot be complete; the terminal rule is that undecidable means refused, and this is the last round

Status: accepted
Date: 2026-09-04
Decided by: orchestrator
Scope: `tests/no-sdk-import.test.ts`, `database-reachability.test.ts`, `apps/web/server/runs/store.test.ts`;
and the closing condition for Wave 2 sub-wave 2a

## Context

[ADR-0030](0030-import-edges-are-resolved-by-the-compiler-not-matched-by-regex.md) replaced three
gates' hand-rolled model of module resolution with the compiler's own. It worked, measurably: fresh
verifiers ran twenty-two and fourteen bypass spellings against the converted gates and the gates
refused twenty and eleven of them, including all six that had walked past every previous round.

The survivors are a different question. They are not about **where a reference points** — that is now
the resolver's job and it does it. They are about **whether a call site is a reference at all**:

```
require.main.require('@anthropic-ai/claude-agent-sdk')
const load = require; load('@anthropic-ai/claude-agent-sdk')
process.mainModule.require('@anthropic-ai/claude-agent-sdk')
```

All three load the SDK — the verifier ran node and watched it happen — and all three pass the gate.
The cause is that the converted gate decides which call sites to look at from three hand-maintained
tables of callee names (`RESOLVER_CALLS`, `OPAQUE_CALLS`, `OPAQUE_PROPERTIES`), and a callee in none
of them **falls out of the branch with no `else`**: neither collected as a reference nor refused as
undecidable. That is [ADR-0027](0027-a-partition-that-lists-its-members-has-not-been-partitioned.md)
clause 1 and [ADR-0015](0015-gates-decide-on-positive-assertions.md), one layer up from where they
were last applied.

The deeper point, which four rounds of spelling-chasing avoided saying: **a static gate over a
dynamic language cannot be complete.** `eval`, `new Function`, a computed specifier, a string
assembled at run time — no static analysis decides these, and no list of callee names ever will. The
question was never "which spelling next"; it was "what does the gate do about the part it cannot
decide".

## Decision

1. **Undecidable means REFUSED, and it is the `else`.** Every call site the gate examines gets a
   verdict from a classifier: a reference it resolved, a reference it could not resolve (hard
   failure), or a construct it cannot decide is a reference (hard failure, naming the file and the
   construct). No call site falls through. `require.main.require` then fails not because the gate
   learned its name, but because the gate does not know it — which is the only formulation that
   terminates.
2. **The gate's own header states the limit rather than implying completeness.** It says what it
   decides, that a sufficiently dynamic construct is refused rather than analysed, and that a
   determined author with `eval` is outside its reach. A security gate that overstates itself is
   worse than one that is honest about its edge, because the overstatement is what stops the next
   reader looking — that has been this programme's most repeated finding.
3. **Project membership comes from the real configuration, not from a nearest-ancestor search.**
   `ts.findConfigFile` walking up to the closest `tsconfig.json` is another model, and neither
   `tsc -p apps/web/tsconfig.json` nor `next build` shares it. Use the configuration those tools use.
4. **A package's export surface is read the way the consumer reads it.** Node and bundlers resolve
   the `default` condition; reading only `types` describes a stub, not what ships.
5. **This is the last repair round of sub-wave 2a.** After it, every remaining finding is written
   into the wave manifest as a declared gap with its counter-example, and the stack proceeds to
   integration. Two things make that safe to say now and they are the only reasons it is:
   * the fix above is *"add the rejecting else"*, not *"add three more names"* — it closes the class
     rather than an instance; and
   * clause 2 means whatever remains is **declared**, and a declared gap is a thing the next wave can
     see. An undeclared one is what this programme actually fears.

## Alternatives considered

* **Add the three callee names.** Rejected: that is round 4 repeated, and the verifier found the
  three by inventing them — there is no argument that a fourth does not exist.
* **Accept the bypasses as declared gaps without the `else`.** Rejected. The distance between "a
  determined author can defeat this gate" and "an ordinary refactor can defeat this gate silently" is
  the whole value of the gate, and the `else` is what separates them.
* **Enforce §42 at run time instead** — a module hook refusing SDK loads outside the boundary file.
  Genuinely stronger and genuinely correct, and it is Wave 3 work at the earliest: it needs the
  runtime layer to own the process. Recorded here as the direction, not adopted now.
* **Keep going until a round returns clean.** Rejected. Five rounds have each closed real defects and
  each found new ones, and rounds 2 and 3 also produced findings my own rule generated rather than
  found ([ADR-0029](0029-a-narrowing-is-a-defect-only-when-a-counter-example-exists.md)). "Until
  clean" is not a stopping condition for adversarial verification of a gate; it is a description of
  an unbounded loop.

## Consequences

* The three gates become stricter in a way that will reject constructs nobody intended to write. That
  cost is real and it is the right side to err on for a boundary spec §42 calls the single thing
  keeping one file between this repository and the SDK.
* A future task that needs a dynamic construct in a scanned file must declare it, which is friction
  by design.
* Five ADRs now govern this one rule (0015, 0027, 0028, 0029, 0030, and this). That is more than any
  rule should need, and the reason is recorded in ADR-0029: the early formulations described a
  symptom. If a sixth is needed, delete the prose and keep only the gates.
