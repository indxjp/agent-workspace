# Use cases

The Agent Store's agent entries, one folder per catalog entry, named by the entry's slug:
`use-cases/<slug>/`. The catalog (`examples/store/catalog/<slug>.ts`) names the folder as the
entry's `source` with `kind: 'agent'`. The ten gallery tutorials stay in `tests/gallery/` and the
four reference apps in `examples/`.

The maintainers' plan for the 100 entries (`use-cases-100-plan.md`) is the source of truth for
everything below; this page is the short version.

## Layout

```text
use-cases/
  kit/                       test machinery only, no production code
  templates/<archetype>/     the generator's templates, one per archetype
  <slug>/
    agent-workspace.yaml     the project file
    agents/<slug>.ts         defineAgent: skills, file grants, tools, output schema, approval policy
    agents/<slug>.md         the instructions
    skills/<name>/SKILL.md   the domain knowledge
    skills/<name>/scripts/   only when a step must be deterministic
    surfaces/main.ts         defineSurface: greeting, suggested prompts, result cards
    evals/<slug>.yaml        at least four cases and a promotion bar
    data/ja/, data/en/       fictional sample data, in the export format of a real system
    <slug>.test.ts           contract and flow tests
    aw-generated.json        which files the generator wrote
```

Every folder other than `kit/` and `templates/` is a use case: it is named by a kebab-case slug,
holds `agent-workspace.yaml` (`layout.test.ts`), and has a catalog entry under that slug
(`tests/store/catalog.test.ts`). A live entry's folder and demo agent must exist.

## The archetypes

Every entry is one of seven shapes, and starts as an unedited copy of its archetype's template.

| Code | Archetype            | Shape                                                                                  |
| ---- | -------------------- | -------------------------------------------------------------------------------------- |
| QA   | Grounded answers     | Question, `search_files` over granted folders, typed answer with citations.            |
| RV   | Review to a standard | A document in, one verdict per item with a fix, report written behind approval.        |
| TR   | Intake and triage    | Webhook trigger, classify and route; the routing write waits for approval.             |
| RP   | Scheduled report     | Schedule trigger, collect, typed report written to a folder, owner notified.           |
| AN   | Analysis             | Spreadsheet or CSV in, a deterministic skill script computes, table and commentary.    |
| DR   | Drafting             | Notes and sources in, a document written behind approval (Markdown, docx, pptx, xlsx). |
| AC   | Action               | A request in chat, the change in a system through a connector, behind approval.        |

## The budget

A use case writes no code for something the platform does. Its handwritten lines stay within the
budget below. Every file counts except what is not code: Markdown, the eval YAML under `evals/`,
`data/`, tests and test support, and generated files still exactly as the template makes them.

| Archetype          | Lines |
| ------------------ | ----- |
| QA                 | 40    |
| RV, TR, RP, DR, AC | 80    |
| AN                 | 150   |

Code two entries would both write moves into the platform instead. Every handwritten file is
covered to 100% of lines, branches, functions and statements, with no suppression. Code is
TypeScript or JavaScript (`.ts`, `.tsx`, `.mts`, `.js`, `.jsx`, `.mjs`, `.cjs`). A use case may not
carry a script the coverage gate cannot measure: `.py`, `.sh` and other languages, and `.cts`.

## Reading a table in a skill script

A script that computes over a CSV or `.xlsx` export does not parse it itself. It imports the
built-in table reader and command line by their package path, and is then only its calculation
(ADR-0173):

```js
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import { readTable } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

const spec = { usage: 'analyse.mjs <export.csv>', positionals: ['file'] };
runWhenMain(import.meta.url, spec, ({ positionals }) => {
  const { rows } = readTable(positionals.file, {
    columns: { month: ['年月', 'month'], budget: { names: ['予算', 'budget'], type: 'whole' } },
  });
  return { total: rows.reduce((sum, row) => sum + row.budget, 0) };
});
```

The agent must grant `builtinSkill('office-reader')`. In a run, `run_skill_script` resolves the
package path to that placed skill, and only when the placed skill is the shipped one: a person's
own copy under that name is refused. The contract tier fails an entry whose script imports a
built-in skill that its agent does not grant. In the repository, the path resolves like any other
package import, so it costs the budget nothing.

`readTable` refuses a stray or unclosed quote, a row of the wrong width, a missing column, an
empty required cell and an unreadable number. In an `.xlsx`, it also refuses an error cell, a
number that is only part of a merged range, and a date-styled cell in a column that is not of type
`date`. Each refusal is a `TableError` that names the row, the column and the value. A record whose
cells are all blank is skipped. `runWhenMain` prints the result as JSON. It prints a refusal as
JSON on stderr, with exit code 1 for the data and 2 for the arguments.

## The kit

`kit/` is test machinery only; nothing in a use case's own files may import it.

- **The generator.** `pnpm use-cases:new <QA|RV|TR|RP|AN|DR|AC> <slug>` copies
  `templates/<archetype>/` into `<slug>/` (`__slug__` in a path or text becomes the slug) and writes
  `aw-generated.json`. Its one entry, `project:<archetype>` in lower case (`project:qa`), is where an
  entry's archetype is declared. The budget reads the archetype from there. To decide which files
  are still generated, it recomputes them from `templates/<archetype>/`; it never trusts the
  manifest's hashes. It refuses any other entry, any edit, or a recorded hash that the template
  does not produce. While an archetype has no template, nothing counts as generated.
- **`describeUseCase(slug, { definitions, flows })`** in `<slug>.test.ts` runs three tiers. Contract:
  the project loads the way `aw check` loads it, `evals/<slug>.yaml` has at least four cases tagged
  `suggested`, `other-language`, `out-of-scope` and `safety` and the project's
  `policy.promotion.minEvalScore` is at least 0.9, the catalog entry agrees with the folder, no
  agent auto-approves `run_skill_script` while a script could write: it grants `office-writer`,
  holds `writeFiles` or has a read-write file grant (ADR-0167 D5, #2388), nor auto-approves `Bash`
  while it grants `office-writer` (a shell command is outside the engine's `outputs/` deny), and every
  folder an agent is granted is named from the slug (the per-entry folder rule, under "The
  templates"). An agent also grants every built-in skill its own skills' scripts import
  (`builtinImportProblems`, ADR-0173). Moment:
  a live entry's committed recordings pass `judgeMoment` in JA and EN. Flow: each listed flow runs
  against the gallery's scripted workspace; an entry with code beyond its definitions must list
  one. `definitions` are the default exports of `agents/*.ts` and `surfaces/*.ts`, imported
  statically.
- **The budget.** `benchmark.test.ts` measures every use case with the counter the apps benchmark
  uses (`tests/apps/handwritten.ts`). It also counts every file a production file imports, wherever
  that file is, except a `.d.ts` or JSON. Imports resolve as TypeScript resolves them. The budget
  fails when:
  - a relative import does not resolve;
  - an import is a subpath (`#…`) or an absolute path;
  - a production file imports anything under `data/` but a `.json` file (code, WebAssembly, a
    native addon, text) or test support. A JSON file under `data/` is data: production code may
    import it (a public-source snapshot, ADR-0170), and it stays uncounted;
  - a use case carries a script that coverage cannot measure.
- **Coverage.** `pnpm test:coverage:use-cases` (`vitest.use-cases.coverage.config.ts`) holds every
  TypeScript or JavaScript file under `use-cases/*/` at 100% per file.
- **The scoreboard.** `SCOREBOARD.md` is generated from the catalog, the committed evidence and
  the entries' files: one row per catalog entry, one column per check of the definition of done. A
  check that cannot be computed yet is shown as not done. To fill Contract, the generator runs each
  entry's own test in a child Vitest and reads the contract tier's results. `kit/scoreboard.test.ts`
  fails when the file is stale; `USE_CASES_WRITE=1 pnpm vitest run --project use-cases
kit/scoreboard.test.ts` rewrites it.
- **Coverage on the scoreboard.** The Coverage column needs the summary of
  `pnpm test:coverage:use-cases`, which `pnpm test` does not have. So the column is written with
  the summary, and checked against it in CI, and the committed file never flips between runs:
  - write it with the summary: `pnpm test:coverage:use-cases`, then
    `USE_CASES_COVERAGE_SUMMARY=coverage/use-cases/coverage-summary.json USE_CASES_WRITE=1 pnpm vitest run --project use-cases kit/scoreboard.test.ts`;
  - without a summary (`pnpm test`, or a rewrite for another reason) the committed Coverage cells
    are kept as they are, and every other cell is checked;
  - the `coverage` job of CI, which runs the use cases' suite on every pull request that reaches
    their tests, runs the same check with the summary and fails when a cell marked done is not at
    100% in it. A cell left not done while the code is covered is allowed: the file may claim
    less than the summary shows, never more.
- **R1 and the source hash.** A real-model record in `examples/store/catalog/real-model-runs.json`
  carries the entry's source hash (`tests/store/live-verify/source-hash.ts`): the sha256 of the
  files git tracks under its source folder, by sorted path and content, and of its demo block in the
  catalog (agent, prompts, moment check, seed and records, but not `status`). Tests, test support,
  `e2e/` and the folder's top-level `README.md` are left out (they never reach the agent), and so
  is everything outside the folder: the shared packages and the gallery harness, which the daily
  production test watches instead. The R1 column, and the promotion to live, count only a passing
  record for the current hash, so a change to the source, a prompt or the check makes it stale.
- **Real-model verification.** `store-live-verify.yml` (dispatch only, a person types the spend
  approval) takes an `entries` input: comma-separated slugs, so a batch verifies only its own
  entries. Left empty, it verifies every entry with a source (live, or coming soon with its code
  merged) that has no passing record for its current source hash. It verifies the code that runs:
  before spending, it refuses an entry whose source folder or catalog file differs from the commit
  the latest successful staging deploy seeded from, and one whose copy in the verification
  workspace has other instructions than that code, so it is dispatched on `main` after that code is
  deployed. A person reads the evidence artifact and commits it.
- **Seeded while coming soon.** A `soon` catalog entry may carry its `kind`, `source`, `demo` and
  `safety` once its code is merged; the catalog test checks them like a live entry's, and the store
  still shows it as coming soon. The staging deploy seeds a demo template for every entry with a
  source and refreshes the verification workspace from them, so R1 can run before the flip.
  Production seeds the live entries only.

## The templates

`templates/<archetype>/` is what an entry starts as, so every file in it is checked:

- Its agent and surface files are type-checked and linted in place (knip lists them as entries,
  since only the generator reads them).
- It ships no test file: a test's relative import of the kit (`../kit/describe-use-case.ts`)
  resolves to nothing from `templates/<archetype>/`, and the repository's import gate refuses an
  unresolvable import anywhere. No checker excludes the templates.
- `kit/templates.test.ts` generates a probe entry from every template into a temporary folder under
  `use-cases/` and runs the contract checks on it: the project loads the way `aw check` loads it
  (the contract tier of `describeUseCase`, in a child Vitest run that also imports every other
  code file of the probe, so a broken helper or skill-script import fails), its evals have the four kinds and
  the bar, and its triggers parse with `CreateTriggerRequestSchema` (`triggers/*.json`, or the
  default export of `triggers/*.ts`). A broken template fails there even when no entry matches it
  any more.
- A template's instructions treat document content as evidence, never as instructions, and its
  evals carry a `safety` case for an instruction planted in a source document.
- **One folder per entry.** Every folder a template grants is named from `__slug__`, so each entry
  generated from it has its own and keeps the agent file unedited: the inputs are read from
  `<slug>/` (with subfolders where the archetype has several inputs, such as RV's `<slug>/inbox/`
  and `<slug>/standards/`), and an output folder is the sibling `<slug>-reports/`, granted
  read-write. The output is a sibling, never a subfolder: a read grant denies writes under its whole
  folder, and the inputs stay read-only. Two entries in one visitor's workspace then never share a
  seed collection (the catalog refuses that) or an output folder. The contract tier checks it for
  every entry (`grants only folders named from its slug`: `<slug>`, `<slug>-reports` or a subfolder of either; no catalog slug ends in `-reports`), and
  the probe of every template runs that check. A template's skill is named from `__slug__` as well
  (`skills/<slug>/`): the verification workspace holds every seeded entry at once, and two entries
  carrying one skill name with different content would replace each other's. The probe checks it.
- A write and a skill script wait for a person: a template that writes puts `Write` (and, when it
  holds a read-write grant, `run_skill_script`) in `requireApproval`. A tool that is neither
  auto-approved nor gated is refused, not paused, so a template never leaves one ungated.

## Adding one

1. Add the catalog entry `examples/store/catalog/<slug>.ts` as `status: 'soon'` if it is not
   there yet.
2. Run `pnpm use-cases:new <archetype> <slug>`, then change only what the entry needs:
   instructions, skills, the agent file and the surface. Replace the template's `data/` example
   with the entry's own data, laid out as the template's folders expect (RV: `data/ja/inbox/` and
   `data/ja/standards/`). A file left exactly as generated counts zero lines: the template names
   every folder from the slug, so `agents/<slug>.ts` never needs a folder renamed; keep its grants
   and comments as generated. The catalog's `demo.seed` copies the data into `<slug>`
   (`{ collection: '<slug>', from: 'data/ja' }`, or `from: 'data'` for both languages), and prompts
   and eval judges name paths under `<slug>/` and `<slug>-reports/`. The
   template's eval cases marked as placeholders must be replaced with the entry's own. Write the
   entry's own `<slug>.test.ts` (`describeUseCase(slug, { definitions })`, not counted); it lists a
   flow only once the entry has code beyond its definitions.
3. Write bilingual (Japanese first), fictional sample data and at least four tagged eval cases.
   Give the demo at least two suggested prompts, each in Japanese and English: two different
   requests the agent handles with its sample data (another day, owner, threshold or person, not
   a rephrase), in the catalog's `demo.prompts` and the surface's `suggestedPrompts`, each with an
   eval case tagged `suggested`. The templates start with two. The prompts are part of the source
   hash that R1 records, so `tests/store/sample-data.test.ts` holds a coming-soon entry with a demo
   to the rules a live one meets (two prompts, only seeded files named, a check naming only tools
   the demo agent can call and the approval tool apart): one added at the flip would make R1 stale.
4. Run `pnpm vitest run --project use-cases`, `pnpm test:coverage:use-cases` and
   `pnpm vitest run --project tests-store`, and regenerate the scoreboard with the coverage summary (above).
5. In the same change, give the catalog entry its `kind: 'agent'`, `source: 'use-cases/<slug>'`,
   `demo` block and `safety` while it stays `status: 'soon'`, list its demo agent in
   `tests/store/demo-agents.test-support.ts`, and, for an `mcp()` connector, add its tools to
   `CONNECTOR_TOOLS` in `tests/store/seed/build.ts`. Once merged, the staging deploy seeds it and
   refreshes the verification workspace. An entry whose surface declares `resultCharts` (ADR-0168)
   also gives its `demo` an `outputSchema`, a copy of its suggested eval case's schema: the Try it
   section asks its runs for it and draws the charts under the answer. List the surface in
   `tests/store/result-charts.test.ts` and regenerate `charts.generated.ts` with `APPS_WRITE=1`;
   that test fails when the schema differs from the eval case's or lacks a charted field.
6. Dispatch `store-live-verify.yml` on `main` with `entries` set to the batch's slugs. The entry
   turns `live` in a separate change that changes only its `status` and adds the passing record.

Sandboxes have no internet, every write waits for approval, and an entry about people surfaces
evidence; it never ranks, scores or rejects a person.
