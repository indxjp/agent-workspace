# ADR-0032 — Inside a research fixture, an unresolvable *bare* specifier is a classified verdict, not a §42 refusal; and the fixture's own README must name the package

Status: accepted
Date: 2026-09-05
Decided by: orchestrator, on the sub-wave 2a integration branch
Scope: `tests/no-sdk-import.test.ts` at integration level; `docs/research/fixtures/**`

## Context

The 2a integration branch merged six branches. Every gate passed on the union — build, typecheck,
lint, format, the ownership self-test, the wave-plan disjointness check, the regenerated ADR index,
and both inventory gates whose input sets are now larger than any single branch saw — with **exactly
one failure**, and it is the one the integration exists to find:

```
FAIL |tests| no-sdk-import.test.ts > the §42 boundary gate can actually run
     > found no module reference it cannot decide
AssertionError: module references this gate cannot resolve; it refuses to pass over them:
  expected [ …(31) ] to deeply equal []
```

Nine of R-06's probe files import `@modelcontextprotocol/sdk/...`, which no `package.json` in this
repository declares and which is absent from `node_modules`. Under
[ADR-0031](0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md) an unresolvable
reference is a hard failure, so the gate refuses them.

**Neither branch is wrong.** Both designs are right, and they were built without seeing each other:

* `W2-INT-01` made unresolvable mean refused because a reference the gate cannot decide is one it
  must not wave through. That is correct for the tree §42 protects.
* `R-06`'s probes are **documented as copy-out-and-run artefacts**. Its fixture README prints
  `npm init -y && npm install @anthropic-ai/claude-agent-sdk@0.3.258 @modelcontextprotocol/sdk@1.30.0`
  and explains that the probes must be run from their own installation, because Node resolves bare
  specifiers relative to the running file. They are evidence, not code that ships.

The premises of the fixture boundary hold, and were re-derived rather than taken from the earlier
ADR that asserted them: `.dockerignore` excludes `docs/`; no tracked `tsconfig` includes `docs`; and
nothing outside the fixture directory names a module inside it.

So the rule is what is wrong. ADR-0031's "unresolvable is a hard failure" was written about the tree
the gate protects, and a research fixture is explicitly not that tree.

## Decision

1. **Inside `docs/research/fixtures/**`, an unresolvable BARE specifier gets its own verdict** —
   *"a package this repository does not declare, in a directory nothing here imports"* — and the
   gate reports that set by name. It is a classification, not a skip, and the set is asserted so it
   cannot grow silently ([ADR-0015](0015-gates-decide-on-positive-assertions.md)).
2. **A RELATIVE specifier that does not resolve stays a hard failure, everywhere, fixtures
   included.** A broken relative path inside a fixture is a real defect and nothing about running
   elsewhere excuses it. Only the bare case is about a dependency the fixture installs for itself.
3. **The fixture directory's README must name the package.** The gate reads it and fails if an
   unresolvable bare specifier's package is not documented there. This is what stops the verdict
   becoming a hole: "documented as run elsewhere" is now checked against the document, not assumed —
   and it turns R-06's install line into an artefact something depends on
   ([ADR-0016](0016-measured-numbers-do-not-live-in-prose.md)).
4. **The soundness control is unchanged and is what actually carries the safety**: nothing outside
   `docs/research/fixtures/**` may name a module inside it. That control is independent of
   resolvability, and it is why a fixture cannot become a back door whether its imports resolve or
   not.
5. **`tests/no-sdk-import.test.ts` passes to the integration level for this change**
   ([ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md)). Neither branch could make
   it: the change is only correct in the presence of both, and each is green alone.

## Alternatives considered

* **Declare `@modelcontextprotocol/sdk` as a repository dependency.** Rejected: it adds a production
  dependency the product does not use, to make a documentation artefact resolve. Spec §40's
  dependency rule is against exactly that, and it would also make the probes resolve against a
  version this repository pins rather than the one the note was written against — quietly changing
  what the evidence means.
* **Exclude the fixture directory from the gate's scan.** Rejected: that is the directory exclusion
  the gate's own header says it does not have, and it would take the SDK-import permit with it — the
  permit is the reason the directory is scanned at all.
* **Change R-06's fixtures to vendor or stub the MCP SDK.** Rejected: the probes' value is that they
  ran against the real package at a pinned version. A stub would make the note's `verified` rows
  false, which is the failure R-06 was already sent back three times for.
* **Declare it as a gap and land red.** Rejected: a red gate on `main` is a gate everyone learns to
  ignore, and this one is two days old.

## Consequences

* The gate reads a README, which is a new kind of input for it and a new thing that can rot. It rots
  loudly: the assertion fails when the README stops naming a package a fixture imports.
* A future research note that imports an undeclared package must document it in its fixture README.
  That is a requirement the reviewer checklist already implies and now enforces.
* This is the first union-only failure of Wave 2 and it cost one integration cycle. Wave 1a's
  equivalent cost seven failures and a corrective sub-wave, so the decomposition improved — the
  reason is that this failure is a genuine conflict of two correct designs rather than three gates
  asserting a closed world over globs their authors did not own.
