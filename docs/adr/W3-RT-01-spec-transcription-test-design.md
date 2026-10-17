# W3-RT-01 — how `spec-transcription.test.ts` compares `docs/spec.md` to `driver.ts`/`types.ts`

Status: accepted
Date: 2026-09-06
Decided by: W3-RT-01 (the one abstraction)
Scope: `packages/runtime/src/spec-transcription.test.ts`; a pattern the drivers of 3b and the
suites of W3-QA-02 / W3-CP-06 cite by name rather than re-derive, since all three do "read a spec
block and assert against it"

## Context

This task's Accept criterion requires *"a transcription test that reads `docs/spec.md`: it locates
the fenced `ts` block ... extracts every member name and its type text, and asserts the set of
member names and their optionality equals what `driver.ts` and `types.ts` export — failing by
naming the member that differs."* Plan §3.1 calls these interfaces PL-0, *"creativity is a
defect"* — so the test needs to compare structure, not read like a hand-written opinion about it.
Four design questions had no single obviously-correct answer and are recorded here.

## Decisions

**1. Comparison is by the TypeScript compiler API, not regex, on both sides.**
ADR-0030 states this for import edges; the same reasoning applies to type shapes — six spellings
have already walked past a regex-based gate in this repository for a simpler problem than "does
this member's type text match." `ts.createSourceFile` parses both the markdown-extracted spec
snippet and the real `driver.ts`/`types.ts` source, and `ts.SyntaxKind` checks (`isPropertySignature`,
`isMethodSignature`, `isTypeLiteralNode`, `isUnionTypeNode`, `isLiteralTypeNode`) drive extraction.

**2. Extraction is strict for spec blocks, lenient for implementation files — a different
tolerance in each direction, not a lowered bar.**
A spec fenced block is asserted to contain nothing but type aliases and interfaces; a top-level
construct this reader does not recognise there is refused (`extractDeclarations(..., { strict:
true })` throws, naming the construct kind) rather than silently skipped, per ADR-0031: "undecidable"
must mean refused, and refusing here is cheap because the fenced block is small and controlled.
`driver.ts`/`types.ts`, by contrast, legitimately contain `import` statements and file-header
comments that are not part of what is being compared; treating those as failures would make the
gate reject its own subject matter for having a header. Lenient mode (`{ strict: false }`) is used
only there, and only to skip non-declaration statements — it applies exactly the same object/union
extraction to whatever type aliases and interfaces it does find.

**3. Type text is compared after canonicalizing through the TS printer, minus one measured
exception.**
A first version printed through `ts.createPrinter().printNode(...)` alone, on the assumption that
the printer canonicalizes quote style. It does not, for an unmodified parsed literal, on this
repository's pinned TypeScript (5.9.3) — verified directly, not assumed: the first real run of this
test against the real `RuntimeCapabilities` and `RuntimeProfile` failed, quoting the printer's own
output, with `implementation "'none' | 'os-sandbox' | ..."` still single-quoted next to `spec
"\"none\" | \"os-sandbox\" | ..."` still double-quoted. (Round 1's PR body did not carry the pasted
failure this parenthetical originally pointed at; round 1's verifier reproduced the same failure
independently against this repository's pinned TypeScript 5.9.3, so the underlying claim stands —
only the dangling pointer is corrected here, per ADR-0016.) The actual fix is a second, explicit
normalization: replace `'` with `"` in the printed
text. This is exact rather than a heuristic for
the specific type expressions in scope here (unions of driver ids, network policies, isolation
levels, filesystem modes; `Record<string, unknown>`; `Promise<...>`; `AsyncIterable<...>`) because
none of them can legitimately contain an apostrophe — a type expression that ever needed one would
break this normalization, which is the kind of narrow, load-bearing assumption ADR-0031 asks to be
named rather than left implicit.

A second, similarly narrow normalization strips a leading `readonly ` token from printed type text.
This exists because `driver.ts`'s `RuntimeCapabilities.networkPolicies` is declared as `readonly
('none' | 'allowlist' | 'open')[]` — a readonly-array **type**, part of this repository's existing
convention of transcribing spec interfaces as `type` aliases with `readonly` members (`driver.ts`'s
own header explains why) — while §14.5's printed interface has the plain, non-readonly array type.
Stripping the prefix is safe here specifically because `readonly` is a reserved keyword that cannot
appear as a bare identifier elsewhere in one of these type expressions.

**4. Exactly one generic-parameter substitution table, applied only to spec-side member type text,
citing the ADR that already settled it.**
`RuntimeDriver.startAgent` and `AgentConnection.events` reference `AgentRunRequest`/`AgentEvent` in
the spec's printed, non-generic interfaces; `driver.ts` uses `TRequest`/`TEvent` because this
package may not depend on `@agent-workspace/core`, where the concrete types live
(`docs/adr/W1-RN-02-runtime-driver-is-generic.md`, already accepted before this task). Comparing
those members literally would fail forever on a difference this repository already decided is
correct. `substituteGenericSeam()` rewrites exactly `AgentRunRequest` → `TRequest`, `AgentEvent` →
`TEvent`, and a bare `AgentConnection` (not followed by `<`) → `AgentConnection<TEvent>`, applied
only to already-extracted, per-member type text strings extracted from the **spec** side — never to
a whole document, and never to a declaration name (so the `AgentConnection` interface's own name
stays `AgentConnection`, only its *use* as a return type gains the parameter). No other
substitution exists; a future spec change to some other identifier is compared literally and fails
if the two sides do not match textually.

**5. Which constructs get compared is derived from the parsed spec map's keys, never a hand-typed
list of names (added in round 2, closing B1).**
Round 1 shipped `it.each(['RuntimeDriverId', 'RuntimeHandle', 'RuntimeDriver', 'AgentConnection'])`
and two single-name `it()` calls for `RuntimeCapabilities` / `RuntimeProfile` — a literal array of
construct names sitting immediately beside `specDeclarationsUnder()`, which already parses the
fenced block into a complete `name -> Shape` map. Nothing compared that map's key set against the
tested set, so an interface a spec fenced block gained and this array did not name was parsed
successfully and then dropped: accepted by never being looked up, the exact "decide by absence"
ADR-0015 forbids, one level up from where the rest of this file already avoids it (member
granularity was always derived from the actual parsed members; construct granularity, until now,
was not). The fix replaces all three name arrays with `[...spec142.keys()]` /
`[...spec145.keys()]` / `[...spec151.keys()]`, so `it.each` runs one test per construct the block
actually declares; a construct absent from the implementation still fails with the same
`getDeclaration()` error naming it, only now nothing needs a human to have remembered to add its
name to a list first.

This introduces no exclusions: `[...spec142.keys()]` is exactly `RuntimeDriverId`, `RuntimeHandle`,
`RuntimeDriver`, `AgentConnection` (verified — `pnpm vitest run
packages/runtime/src/spec-transcription.test.ts` after the change still reports `13 passed (13)`,
unchanged from before it), `spec145` is exactly `RuntimeCapabilities`, and `spec151` is exactly
`RuntimeProfile`. §14.2/§14.5/§15.1's fenced blocks declare nothing else as of this writing. Should
one of them ever legitimately declare a construct `driver.ts`/`types.ts` does not export, the
correct fix is a **named, justified exclusion asserted as an exact set** (e.g. an explicit
`EXCLUDED_FROM_TRANSCRIPTION` set the code diffs the derived keys against and fails on any
addition), never a silent filter — an exclusion list that can grow without failing anything is
this same defect one level further down.

## What this test cannot decide, stated once (ADR-0031)

This is a static, syntactic comparison of printed type text. It cannot tell that two
differently-written type expressions denote the same TypeScript type (e.g. a reordered union), and
it does not compare JSDoc prose at all — both are **conservative** failure directions: they can
make the gate fail on two things a person would call equivalent, never make it pass on two things
that actually differ. The Wave 3 plan's own note on sub-wave 2b-1 is the reason this
sentence is written once and not qualified away in the next paragraph: a stated limit that is then
narrowed back to "but it's fine in practice" is not a limit.

## Alternatives considered

* **Compare against a hand-written list of expected members, or of expected constructs**,
  refreshed by whoever edits `driver.ts`. Rejected at both granularities: this is exactly the
  "hand-written lists go stale" failure sub-wave 2b-1 paid for three rounds running — a list
  divorced from the spec text drifts the moment the spec changes and nothing notices. Member
  granularity was never hand-written (member sets always came from parsing `objectMembers()`'s
  actual output). Construct granularity briefly was, in round 1's first version of this file — a
  literal array of construct names beside the very map that could have supplied them — until round
  2 replaced it with the derived key set (decision 5, above). That gap, not this rejection, was the
  defect; this bullet describes what the shipped code has done at both granularities since round 2.
* **Runtime introspection instead of source parsing** (e.g. reflect over the compiled `.d.ts` with
  some type-level testing library). Rejected: TypeScript types do not exist at run time, and a
  `.d.ts`-based approach still needs a parser for the declaration file — the compiler API applied
  directly to the `.ts` source is the more direct version of the same idea, with one fewer
  build step between "what's written" and "what's checked."
