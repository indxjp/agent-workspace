# The formal specification

Agent Workspace's meaning, as a platform and as an SDK, is stated as a Lean 4 model in
[`formal/`](../../formal). The TypeScript is tested against that model by generated differential
vectors ([ADR-0062](../adr/0062-the-specification-is-a-lean-4-model-and-typescript-is-tested-against-it.md)).
This page covers how to build it, how it is organised and how to add to it.

| Document | What it is |
| --- | --- |
| [`00-orchestrator-prompt.md`](00-orchestrator-prompt.md) | The programme's charter and the rules every unit follows |
| [`inventory.md`](inventory.md) | The formalisable surface of the TypeScript, with paths and symbols |
| [`catalogue.md`](catalogue.md) | Every theorem, by tier and family (generated) |
| [`traceability.md`](traceability.md) | Document anchor ↔ Lean name ↔ TypeScript symbol ↔ test (generated) |
| [`concepts.md`](concepts.md) | The concept glossary and the canonical ER model |
| [`findings.md`](findings.md) | Disagreements the formalisation exposed, and their resolution |
| [`decisions.md`](decisions.md) | Modelling and tooling decisions made during the programme |
| [`manifest.md`](manifest.md) | Programme state: phases, runs, counts, next action |

## Setting up

Install [elan](https://github.com/leanprover/elan), Lean's toolchain manager. `formal/lean-toolchain`
pins the Lean release, and elan fetches it on the first build.

```sh
# Linux / macOS (CI does the same with a checksum-verified release archive)
curl -sSfL https://github.com/leanprover/elan/releases/download/v4.2.4/elan-x86_64-unknown-linux-gnu.tar.gz | tar -xz
./elan-init -y --default-toolchain none
# Windows: download elan-x86_64-pc-windows-msvc.zip from the same release and run elan-init.exe
```

Then, from the repository root:

```sh
pnpm formal:build       # lake build: the model and the four tools
pnpm formal:generate    # rewrite ErSnapshot.lean, catalogue.json, the vectors, catalogue.md, traceability.md
pnpm formal:check       # build + axiom audit + layer check + generated artefacts current
pnpm vitest run tests/formal apps/web/formal apps/runner/formal   # replay the vectors
```

The first build downloads Batteries and Plausible and compiles them, which takes a few minutes.
Later builds are incremental.

## Layout

```
formal/
  AgentWorkspace/
    Trace/Spec.lean        the @[aw_spec] attribute (tier, doc and ts citations)
    Prelude/               WireEnum (closed string unions and their codec), Json
    Contracts/             one module per packages/contracts module
    Concepts/, Er/         the concept model; Er/Current (today's schema), Er/Target, the refinement
    Authz/                 roles, the decision table, ownership, conferral, token scope, tenancy
    Behaviour/, Lifecycle/, Events/   operations as pure state transitions; state machines; SSE
    Sdk/, Cli/             what the SDK consumer and the aw user can rely on
    Theorems/<Tier>/       WellFormed (T0), Normative (T1), Invariants (T2), Adversarial (T3),
                           Refinement (T4), Meta (T5)
  Vectors/                 the vector emitters, one module per family
  Tools/                   lake exe catalogue | axioms | imports
  generated/               ErSnapshot.lean, catalogue.json and vectors/<family>/*.json — committed,
                           never edited
```

The layer direction is enforced by `lake exe imports`:
`Trace → Prelude → Contracts → Concepts/Er → Authz → Behaviour/Lifecycle/Events → Sdk/Cli → Theorems`.
`Contracts` sees only `Prelude`. `Sdk` and `Cli` see only `Prelude`, `Contracts` and `Events`.
Nothing but `Theorems` and the root imports `Theorems`.

## Rules for Lean code in this repository

- Model the **observable** behaviour as pure functions over an explicit state. The model has no IO,
  no clock and no randomness: time and identifiers are inputs.
- Every closed union is an `inductive` with `DecidableEq` and `Repr`. A wire enumeration also gets a
  `WireEnum` instance, whose member list follows the TypeScript `as const` order, and so a JSON codec
  with a proved round-trip.
- Where today's code and the target design differ, model both (`…Current`, `…Target`) and state how
  they relate as a theorem.
- Every theorem under `Theorems/` has a docstring stating the property in one English sentence, and
  `@[aw_spec (tier := Tn) …]` with the tier of its directory. A helper lemma is `private`.
- Cite the exact document heading (`doc := "docs/…md#github-style-anchor"`) and TypeScript symbol
  (`ts := "path#symbol"`). `pnpm formal:generate` rejects a citation that does not resolve.
- No `sorry`, `admit`, `axiom` or `native_decide`. Prefer `decide`, `simp` and `omega`. For a table
  with N cells, generate the N cell theorems rather than copying them by hand.
- Every theorem with hypotheses has a witness: an `example` that satisfies them, or a positive
  vector.

## A schema migration

The ER snapshot pins are generated, not typed. `pnpm formal:generate` reads the latest entry of
`migrations/meta/_journal.json` and the `drizzle-kit` snapshot it names, and writes
`formal/generated/ErSnapshot.lean`: the snapshot file (`Er.Snapshot.file`), its table names and its
column, foreign-key, unique-key and check totals. The snapshot-agreement elaborators, the
table-set and total theorems and the `tests/formal` suites read those facts, and `pnpm formal:check`
fails when the file is stale or when the model and the snapshot disagree.

So after `pnpm db:generate`, run `pnpm formal:generate` and commit what it writes. A Lean edit is
still needed when the migration changes what the model says, never only its numbers:

- **Generated (no hand edit):** the snapshot number, the table list and the totals. A migration
  that changes nothing the catalogue records (an ordinary index, a default) needs nothing else.
- **Hand-written:** a new table (its `TableName` constructor, `catalogue` entry, cluster and
  glossary term), a changed column, key or check in `catalogue`, the meaning of a new check, and
  any new behaviour or authorisation rule. The generated theorems name the cell that disagrees.

## Adding a family end to end

The runs slice is the template (`Contracts/Runs.lean`, `Lifecycle/Run.lean`,
`Theorems/*/Runs.lean`, `Vectors/Runs.lean`, `apps/web/formal/runs.test.ts`):

1. Model the wire types and the behaviour. Add the modules to `formal/AgentWorkspace.lean`.
2. State and prove the theorems, each in the directory of its tier.
3. Write `formal/Vectors/<Family>.lean` and add one line to `families` in `formal/Vectors/Main.lean`.
4. Write the conformance suite, which loads the vectors with `loadVectors` from `tests/formal/vectors.ts`
   and replays each one against the real TypeScript. Put it in `tests/formal/<family>.test.ts` when it
   imports packages through their exports, and in `apps/<app>/formal/<family>.test.ts` when it imports
   an application's server code (decision D-012).
5. Run `pnpm formal:generate`, then `pnpm formal:check`, then the vector replay, and commit the
   generated files.
