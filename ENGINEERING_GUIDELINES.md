# Engineering Guidelines

These rules define the default for production code, tests, and coding-agent changes in this
repository. They turn the most useful themes from _Beautiful Code_—clarity of intent, small
interfaces, local reasoning, and correctness visible in structure—into checks that fit this
TypeScript monorepo. A rule may be waived only with a narrow explanation in the review; weakening a
repository-wide gate requires an ADR.

## Design priorities

1. Preserve tenant isolation, authorization, credentials, and durable data.
2. Make invalid external input impossible to use without validation.
3. Keep ownership and dependency direction obvious from the import graph.
4. Prefer a direct implementation over a speculative abstraction.
5. Automate objective rules and use review for context-dependent design.

## Modules and dependencies

- `apps/*` are composition and delivery layers. `packages/*` never import an application.
- Browser code must not import server runtime values or persistence modules. Shared wire contracts
  live in a dependency-light `contracts` module and contain no database or framework dependency.
- Domain contracts do not depend on Drizzle schemas. Persistence adapters translate between rows
  and domain or wire values.
- Import a package through an exported entry point. Do not reach into another package's `src` tree.
- A module should have one reason to change. Split mixed modules by domain responsibility, not by
  arbitrary file length or generic `utils`, `helpers`, `common`, or `manager` folders.
- Avoid barrels that export unrelated implementations or force consumers to load optional drivers.
- Circular dependencies, unresolved internal imports, browser-to-server value imports, and
  package-to-application imports fail `pnpm architecture:check`. The only cycle exceptions are two
  two-file Drizzle relationships: `workspaces.ts` ↔ `model-connections.ts`, required by the
  workspace's tenant-scoped composite foreign key and the model connection's workspace reference,
  and `agents.ts` ↔ `agent-versions.ts`, required by `agents.materialised_version_id` and
  `agent_versions.agent_id` referencing each other. Each has a rule that rejects any third module
  joining it; expanding either exception requires an ADR.
- A route parses its input, calls one service function, and maps the result through
  `apps/web/server/http/route.ts`. A compound operation (more than one write) is a service that
  uses a transaction, or `withCompensation` from `packages/core/src/cleanup.ts` (undo only on
  failure); use `withCleanup` for resources that must always be released.
- A closed vocabulary (statuses, roles, error codes) is defined once in `packages/contracts` and
  imported everywhere else. A storage copy needs a conformance test.
- Migrations are expand/contract: add, backfill, switch readers, then remove in a later release.
  `DROP`, `RENAME`, `SET NOT NULL` and type changes need a `-- safe:` justification
  (`pnpm migrations:lint`).

## Types and runtime boundaries

- Keep `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `useUnknownInCatchVariables`, and the additional root compiler protections enabled.
- Use `unknown` for untrusted values. `any`, `@ts-ignore`, non-null assertions, and broad `as`
  assertions require removal or a documented, narrow proof at the boundary.
- Model state variants with discriminated unions. A switch over a closed union must be exhaustive
  or have an explicit rejecting fallback.
- Optional means genuinely absent. Use `null` for an explicit empty value when it is part of the
  protocol, and do not manufacture `undefined` under an optional key.
- Prefer readonly inputs and return values. Mutate only local construction state or an explicitly
  stateful object.
- Use branded identifiers only where confusing identifiers is a demonstrated risk; do not wrap
  every string.
- Do not maintain a runtime validator and a handwritten duplicate type. Derive the type from the
  schema, or add a compile-time key/conformance check when a canonical external type must remain.

Validate at every trust boundary that consumes structured data:

- HTTP request bodies and important response bodies;
- provider and external-service JSON;
- environment and configuration values;
- persisted JSON and queue messages;
- form and user input.

Zod is the default schema library where a structured contract is reused or has meaningful
constraints. A small explicit predicate is preferable for a one-field check. Schemas reject unknown
keys for owned APIs and may pass through unknown keys only for deliberately extensible external
protocols.

## Functions, complexity, and side effects

- Give a function one observable responsibility. Separate parsing, pure decisions, persistence,
  and transport.
- Prefer early returns to nested conditionals. Replace combinations of boolean flags with a named
  union when the combinations describe states.
- Production cyclomatic complexity above 32 or nesting deeper than 5 fails lint. Complexity above
  15, functions above roughly 80 lines, and source files above roughly 500 lines require review;
  these are hotspot signals, not instructions to fragment cohesive code.
- Side effects belong at application boundaries. Pure transformations should not read globals,
  environment variables, clocks, randomness, or network state implicitly.
- Await promises or deliberately mark background work with an observable failure path. Do not leave
  floating promises.
- Accept `AbortSignal` for potentially long I/O and preserve cancellation when wrapping `fetch`.

## Errors and observability

- Distinguish expected domain failures from unexpected infrastructure or programming failures.
- Convert an external library error into a contextual domain/infrastructure error at the adapter
  boundary. Do not leak raw provider, SQL, filesystem, or secret-bearing messages to clients.
- A route maps known validation and domain failures to stable error codes. Unexpected failures stay
  5xx and must be logged with operation, request/run identifier, workspace context, and cause.
- Never swallow an error unless the operation is explicitly best effort and the failure is still
  observable. Cleanup failures preserve both the primary and cleanup causes, for example with
  `AggregateError`.
- Avoid `console.log` in production modules. Use the structured telemetry/logging boundary
  (`packages/core/src/telemetry`); tests and explicit CLI output may use the console. Read
  `process.env` only in composition roots and entry points.
- `eslint-suppressions.json` is the committed baseline of violations that predate four lint rules:
  `no-console` in web server/app, the runner and the gateway; `process.env` outside composition
  roots and entry points; discarded cleanup failures (`.catch(() => undefined)` or an empty
  `catch` around `destroy`/`delete`/`close`/…); and raw `fetch('/api…')` in browser code. It can
  only shrink: ESLint fails a file that exceeds its recorded count and fails a stale entry (run
  `pnpm exec eslint <project> --prune-suppressions`, then `pnpm format`), and CI fails a diff that
  raises a count (`scripts/check-lint-baseline.mjs`). Never generate it with `--suppress-all` to
  get a change through; inline `eslint-disable` stays forbidden.

## Naming and APIs

- Name modules, functions, and values by domain intent: `parseRuntimeRunSpec`, not `processData`.
- Avoid `data`, `info`, `item`, `temp`, `utils`, `helpers`, `common`, and `manager` when a more
  specific responsibility exists. Very narrow loop variables are exempt.
- Boolean names read as predicates (`isPublic`, `hasAccess`, `canRetry`). Collections use plural
  nouns. Units appear in names (`timeoutSeconds`, `memoryMb`).
- Public functions expose the smallest stable interface. Do not return persistence records over
  HTTP; map them to explicit wire resources.
- Keep API error shapes and transport helpers shared only where the semantics are genuinely common.
  Domain error codes and decisions remain with their domain.

## Comments and documentation

Comments explain why, invariants, external behavior, security constraints, and non-obvious
tradeoffs. They do not narrate syntax.

- Remove commented-out code, obsolete TODOs, reviewer conversations, wave/task chronology, and
  claims that tests or current code contradict.
- A TODO names an owner or issue and an actionable completion condition.
- A temporary storage bridge carries a one-line marker naming the issue that deletes it:
  `// storage-bridge(#<removal issue>): <what it keeps working>`, or in Markdown
  `<!-- storage-bridge(#<removal issue>): … -->`. `tests/storage-bridges.test.ts` rejects any other
  line that mentions it and lists the rest; the debt review counts them, and the last phase of the
  storage design (§06) fails while any remain. `git grep -n "storage-bridge(#1234)"` lists what
  issue #1234 must delete. Each kind of bridge has one removal issue:

  | Bridge                                                                                                                                                                                                                          | Removed by |
  | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
  | dual-read of the old object naming, legacy area providers (`sessions/` dir), `workspaceKeyPrefix`, the one-step catalog methods (`putFile`, `listFiles`, `renameFile`, `deleteFile`, `*ByPrefix`), skill marker-object fallback | #1699      |
  | JSON+base64 skill import                                                                                                                                                                                                        | #1700      |
  | inline `contentBase64` arms of the run protocol                                                                                                                                                                                 | #1701      |
  | `ObjectStoreV2` names and buffered `get/put/list/listPrefix`                                                                                                                                                                    | #1702      |
  | Phase 1 in-place overwrite on a signed upload over an existing file                                                                                                                                                             | #1666      |
  | optional `status` on file-catalog rows until the hand-written file-catalog fakes are replaced                                                                                                                                   | #1634      |

- Exported reusable APIs get TSDoc when purpose, failure modes, units, or invariants are not clear
  from their signature. Do not repeat the parameter name in prose.
- Architectural decisions live in ADRs or `docs/architecture.md`; keep only the current invariant
  beside the code.
- A user-visible change records its changelog entry as a `changes/<slug>.md` fragment
  ([changes/README.md](changes/README.md)), never as an edit to a `CHANGELOG.md`; the release
  pull request collects the fragments.

## Tests

- Test behavior and contracts, not private implementation sequence.
- Prioritize tenant isolation, authorization, parsers/schemas, state transitions, error mapping,
  serialization, and critical adapters.
- Every corrected defect gets a regression test that would have failed before the fix.
- Repository-wide `it.fails`/`test.fails` is reserved for RF characterizations: each title names
  exactly one `RF-###` owner that appears in the `Expires in` column of the
  [RF-001 characterization register](docs/architecture/refactoring/claude-agent-workspace-refactoring-decisions.md#rf-001-characterization-register).
- Boundary schemas need valid, invalid, unknown-key, missing-field, and numeric-bound cases as
  applicable. Wire mappers must prove that real persistence-shaped values satisfy the shared schema.
- Every in-memory store passes the same conformance suite as its PostgreSQL adapter (see
  `describeAgentStoreConformance` in `apps/web/server/agents/store.test.ts`).
- A skipped test is not evidence. Required services are started by `pnpm test`; an unavailable
  prerequisite must fail explicitly in CI.
- Storage story tests are named `[US-STO-xx][type][entry]` and the code they prove carries
  `// @story US-STO-xx`. A cell counts only for an accepted type: web `browser`; sdk `api`,
  `two-server`, `load`; cli `api`; run `api`, `contract`, `load`; chat `api`, `browser`. US-STO-14
  needs `two-server`. The cells are the ● marks of the
  story × entry-point matrix in the storage design (§07 "How we prove it works"). `pnpm stories:check` reports gaps
  and fails on a malformed tag; #1618 blocks new gaps.
- Coverage is a locator for untested risk, not a reason to add assertion-free tests.
- Where a test goes, what CI enforces and how to run each lane: [docs/testing-strategy.md](docs/testing-strategy.md).

## Quality commands

Run these from the repository root:

```sh
pnpm format        # apply formatting
pnpm lint          # type-aware lint and complexity ceilings (nx run-many -t lint)
pnpm typecheck     # every TypeScript project and tool config (nx run-many -t typecheck)
pnpm test          # full test suite with required local services
pnpm build         # every workspace build, in dependency order (nx run-many -t build)
pnpm check:fast    # formatting, types, lint, architecture, dead code, duplication
pnpm check         # check:fast, full tests, and build
pnpm check:ci      # static gates, coverage suites, and build
```

`lint`, `typecheck` and `build` go through the Nx task graph (`nx.json`, the `nx` block of each
workspace `package.json`): tasks run in dependency order, unrelated tasks run side by side, and a
task whose inputs have not changed is replayed from `.nx/cache`. `pnpm nx affected -t lint` runs
only what your branch changed against `main`; `pnpm nx run <project>:test` runs one project's
Vitest suite (it expects the services `pnpm test` would start). CI runs the same targets on
GitHub-hosted runners — see docs/adr/0053.

`dependency-cruiser.config.mjs`, `knip.json`, and `jscpd.json` are ratchets. Fix a real violation;
for a proven dynamic entry point, add the narrowest documented configuration entry. Never exclude a
directory merely to make a report green. Knip enforces unused exports and exported types for every
package and for the runner. The web application is temporarily exempt from only those two issue
classes because Next.js entrypoints and its remaining internal surface need a separate cleanup;
file, dependency, unresolved-import, and duplicate checks still cover the whole app. The runner's
`claude.ts` exception is narrower still: its declaration surface is asserted by the SDK-boundary
test even though no source module imports every deliberately exported symbol.

## Strictness ratchets

`noPropertyAccessFromIndexSignature` is enabled repository-wide. Dictionary-shaped values use
bracket access and boundary parsers narrow required fields before domain code receives them. The
same ratchet approach applies to complexity and duplication thresholds: reduce the named hotspot,
then lower the ceiling in the same change. Never raise a gate to accommodate new code. Coverage
floors ratchet the other way: `scripts/check-coverage-ratchet.mjs` (run in the CI coverage jobs)
fails a pull request that lowers a floor in a `vitest*.coverage.config.ts`, and warns when one trails the measured value by more than 5
points, so a floor is raised with the code and never lowered.

## Sources

- [_Beautiful Code: Leading Programmers Explain How They Think_](https://www.oreilly.com/library/view/beautiful-code/9780596510046/)
- [TypeScript TSConfig reference](https://www.typescriptlang.org/tsconfig/)
- [typescript-eslint typed linting](https://typescript-eslint.io/getting-started/typed-linting/)
- [Zod documentation](https://zod.dev/)
- [Knip configuration](https://knip.dev/reference/configuration)
- [dependency-cruiser rules](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)
