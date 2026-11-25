# ADR-0173 — A use case's script imports the built-in table reader by its package path

Status: accepted
Date: 2026-11-21
Decided by: the implementing agent of G5 (tracker #2383, the use-cases-100 plan), on the Owner's delegation for the plan
Scope: `packages/skills-office/office-reader/scripts/lib/` (new), `packages/skills-office/package.json` (exports), `use-cases/package.json` (the alias), `packages/skills-office/src/` (tests and the bundle), `packages/skills-office/office-reader/scripts/ooxml.mjs` (dates, errors), `packages/engine/src/skill-script.ts` (the resolve hook), `tests/engine/run-skill-script.test.ts`, `use-cases/kit/builtin-modules.test.ts`, `use-cases/kit/contract.ts` (the grant check), `vitest.coverage.config.ts` (the coverage floor)

## Context

About thirteen of the hundred use cases are analyses (archetype AN in the Agent Store 100-use-case
plan, §9 and §10): budget, cash, forecast, kpi, survey, pricing, churn and others. Each takes a CSV
or Excel export and computes in a skill script, so that no number is added up in the model. The
plan's rule (§3.2) is that code two entries would both write moves into the platform.

The first AN entry, budget, shows what each would otherwise repeat. Its `analyse.mjs` carries a
35-line CSV parser and a command-line wrapper around a calculation of about 60 lines. Its review
found two defects in that parser: a stray quote inside an unquoted field swallowed the rows after
it, and a row with more cells than the header was accepted. Thirteen copies would carry thirteen
versions of those defects. And an `.xlsx` export cannot be computed at all: `office-reader` prints
a workbook as JSON on stdout, and a read-only agent cannot save that JSON for a second script.

### What exists

- **`office-reader`** (`packages/skills-office/office-reader/`) is a built-in skill
  (`BUILTIN_SKILL_NAMES`). Its `scripts/ooxml.mjs` exports `readXlsx`, which returns each sheet as
  dense rows. A definition grants it with `builtinSkill('office-reader')`.
- **Placement.** Every engine places each granted skill at `<config>/skills/<name>/`
  (`skillsUnderConfigDirectory` in `packages/engine/src/skills.ts`, the default for every
  adapter), so a granted built-in skill sits beside the entry's own skill.
- **`run_skill_script`** ([ADR-0137](0137-skill-scripts-run-without-a-shell-under-nodes-permission-model.md))
  runs `node --permission --allow-fs-read=<cwd> … <script>`. The script can read the whole working
  directory, the placed skills included, so it can already import any placed module.
- **The repository's import rules for a use case.** Its own files import the platform only by
  package name (`use-cases-reach-the-platform-through-its-packages` in
  `dependency-cruiser.config.mjs`). The budget counts every file a relative import reaches and
  refuses a relative import that does not resolve and a `#…` subpath import
  (`use-cases/kit/budget.ts`). TypeScript checks skill scripts as JavaScript
  (`use-cases/tsconfig.json`), and the repository's import gate resolves every specifier with the
  compiler (`tests/no-sdk-import.test.ts`).

So the import must resolve in two places that differ. In the repository, an entry's script is
`use-cases/<slug>/skills/<skill>/scripts/x.mjs`. In a run, it is
`<cwd>/<config>/skills/<skill>/scripts/x.mjs`, with no `node_modules` anywhere above it.

## Options

### Option A — Import by package path; `run_skill_script` maps the package to the placed built-in skill (recommended)

The script imports `@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs`. In the
repository, that resolves through `node_modules` like any package import, so TypeScript, Vitest,
coverage, the budget, dependency-cruiser and the import gate all see an ordinary package import.
In a run, `run_skill_script` starts Node with one `--import` of a `data:` module that installs a
resolve hook (`module.registerHooks`). The hook maps `<package>/<built-in skill>/scripts/<path>`
to `<config>/skills/<built-in skill>/scripts/<path>`, a placed file that the process may already
read. The package's layout and the placed skill's layout are the same, because
`scripts/bundle.mjs` bundles each skill directory as it is.

The name is `@indx-workspace/builtin-skills`, not the package's own `@agent-workspace/skills-office`.
A third party owns the `@agent-workspace` scope on npm, so no published file may name it
([ADR-0109](0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md)).
The embedded build inlines the engine and refuses any bundle that names it
(`foreign_scope_in_bundle`). A skill an entry ships would also name a package that anyone could
publish. `@indx-workspace` is the platform's own scope. The use cases install the
workspace package under that name with a pnpm alias in `use-cases/package.json`
(`"@indx-workspace/builtin-skills": "workspace:@agent-workspace/skills-office@*"`).

### Option B — A relative import of the sibling skill, `../../office-reader/scripts/lib/table.mjs`

This resolves in a run with no engine change. In the repository it resolves to
`use-cases/<slug>/skills/office-reader/`, which does not exist. Four gates refuse an unresolved
import: TypeScript, the budget, knip and the import gate. Each would need an exception, as would
Vitest, which would need an alias. Rejected: four exceptions to the gates that keep a use case
honest, for one module.

### Option C — Invert the call: the built-in script imports the entry's calculation

`office-reader` would ship `table.mjs <file> --with <skill>/<script>`, which reads the table and
then imports the entry's module to compute. The entry would import nothing. But the agent would
call a script of `office-reader` to run the entry's logic, while the entry's own script shows up as
callable and does nothing on its own. The built-in script would also need its own copy of
`run_skill_script`'s containment check, so that the module it imports is a placed skill script.
Rejected.

### Option D — Copy the module into each entry

This is what the plan's rule forbids, and the duplication check (jscpd) would flag it. Rejected.

## Recommendation

Option A, with the decisions below.

### D1 — The table reader: `office-reader/scripts/lib/table.mjs`

```text
readTable(file, { columns?, sheet? }) → { columns, rows, rowNumbers }
  columns: { [key]: string[] | { names: string[], type?: 'text' | 'whole' | 'decimal' | 'date', optional?: boolean } }
```

- **CSV**, as RFC 4180 writes it, decoded as UTF-8 (anything else is `not_utf8`). A quote opens a
  field only as its first character. Inside a quoted field, a doubled quote is one quote and a line
  break is kept. A quote anywhere else, or text after a closing quote, is `stray_quote`. A quoted
  field that never closes is `unclosed_quote`, named by the line it opened on. A byte order mark is
  dropped. CRLF, LF and CR all end a record. A record whose cells are all blank (`,,,` included)
  is skipped, not refused, in a CSV and in a sheet alike: exports end in such rows.
- **.xlsx**, read with `readXlsx`: the named sheet, or else the first. A sheet's rows are as wide
  as its widest row, so a row is cut to the header's width unless a cell past the header is
  filled. `readXlsx` now also reports, per sheet, the cells whose style shows a date or a time
  (`dates`: a built-in date format, CJK ones included, a custom format code with a date token, or
  an ISO date cell, `t="d"`, whose value is its text),
  the error cells (`errors`, `t="e"`, whose value is now the error's text, `#DIV/0!`, rather than
  `NaN`), and the workbook's date system (`date1904`). Each cell the reader reads is held to them:
  - an error cell is `error_cell`, even in an optional column, and a number cell that holds no
    finite number is `unreadable_cell`, so no column ever reads `NaN`;
  - a date cell is a date. A `date` column turns it into `YYYY-MM-DD` (an ISO date cell only at
    midnight); any other column
    refuses it as `date_cell`, so a serial day is never read as an amount or as text;
  - a cell inside a merged range other than its top left repeats the top-left value, as on screen.
    A `text` or `date` column takes it. A `whole` or `decimal` column refuses it as
    `merged_cell`, because a total spread over merged rows would otherwise be counted once per
    row.
- **Rows.** The first non-blank row is the header. A row whose number of cells differs from the
  header's is `cell_count`. `columns` maps each key the script wants to the header names that
  column may have, for example `['予算', 'budget']`. A key no header name matches is
  `missing_column`, and a key that two header names match is `duplicate_column`. An empty
  required cell is `empty_cell`, and an empty `optional` cell is `null`. Without `columns`, every
  header name becomes an optional text column, and a header with an empty or repeated name is
  refused.
- **Values.** `text` is the cell trimmed. `whole` (`wholeNumber`) takes an optional sign and digits,
  with or without thousands commas (`-1,234`), or an `.xlsx` number that is a safe integer.
  `decimal` (`decimalNumber`) adds a fraction (`1,234.5`) or takes a finite `.xlsx` number. There
  is no exponent, no percent sign and no currency symbol: a value the column cannot read is
  `not_a_whole_number` or `not_a_decimal`. `date` (`dateValue`) takes text `2026-09-30` or
  `2026/9/30` (a day that does not exist is refused), or a date-styled serial in the workbook's
  date system. A number without a date style, a serial with a time of day, and a 1900-system serial
  before 1900-03-01 (where Excel's phantom 1900-02-29 shifts the count) are refused as
  `not_a_date`. All three helpers are exported for the entry's own fields.
- **Errors.** A `TableError` has a `code` and a message that names the row, the column and the
  value. `row` is where a person finds the row: the file's line for a CSV (a quoted line break
  counts), or the sheet's row for a workbook. `rowNumbers[i]` gives that number for `rows[i]`, so
  the entry's own refusals can name the row too. The other refusals are `unreadable_file`,
  `file_too_large` (50 MiB, `TABLE_LIMITS`, checked on the descriptor the file is read from),
  `unsupported_format` (anything but `.csv` and `.xlsx`), `unreadable_workbook` (an
  `OoxmlRefusal`), `unknown_sheet` and `no_header`. The script's own mistakes are a `TypeError`
  instead: an unknown option key, a `sheet` for a CSV, or a malformed column spec.
- **Prototype safety.** Rows and columns are built with `Object.fromEntries` and a `Map`, so a
  header named `__proto__` is an ordinary column.

### D2 — The command line: `office-reader/scripts/lib/cli.mjs`

`runWhenMain(import.meta.url, spec, compute)` makes the script only its calculation. It parses the
arguments against `spec` (`{ usage, positionals, options: { name: { default? } } }`):
`--name value` and `--name=value` are accepted, and everything after a lone `--` is positional. An
unknown, repeated or empty option, or a wrong number of positionals, is refused as `usage` and
exits 2. Otherwise it prints `compute(args)` as JSON on stdout and exits 0. A `TableError`, from
the reader or from `compute` itself, is printed as `{ error, message, row?, column?, value? }` on
stderr and exits 1, as `office-writer` does. Any other error is a fault of the script and is
thrown. That includes a promise returned by `compute`: the calculation is synchronous, so the
process cannot exit before its result is printed. `runScript` and `parseArgs` are exported for
tests. Nothing runs when a test imports the script, so the entry's script needs no branch of its
own to reach 100% coverage.

Both modules live in `scripts/lib/`. `run_skill_script` offers only the direct children of
`scripts/` (ADR-0167 D1), so the agent is never offered a module as a script.

### D3 — The resolve hook in `run_skill_script`

`builtinImportHook(<cwd>/<config>/skills)` returns one `--import=data:text/javascript,…`
argument, which goes after the permission flags and before the script. The hook resolves only
specifiers of `@indx-workspace/builtin-skills` (`BUILTIN_SKILL_PACKAGE`). `BUILTIN_IMPORTS` in
`packages/engine` lists, per built-in skill, the modules a script may import
(`office-reader`: `scripts/lib/cli.mjs`, `scripts/lib/table.mjs`) and the sha256 of every file
those modules load (the two, plus `scripts/ooxml.mjs`).

- `<package>/<skill>/<module>`, for a listed module, resolves to `file://<skills>/<skill>/<module>`.
  The comparison is exact against the list, so no path is built from the specifier beyond a listed
  name. The file is inside `<cwd>`, which the process may already read, so the hook grants nothing
  new.
- **The placed skill must be the shipped one.** A skill a person imported or edited under a
  built-in's name is theirs and is never overwritten (`apps/web/server/skills/builtin.ts`), so
  the name alone does not make a placed skill the built-in. Before the first import from a skill,
  the hook hashes every file `BUILTIN_IMPORTS` lists for it. If any differs from the shipped
  digest, the import is refused as `builtin_skill_modified`. A person's own `office-reader` is
  never loaded in the place of the platform's.
- If the skill is not placed, because the run does not grant it, the import is refused as
  `builtin_skill_not_granted`, with a message that names `builtinSkill('<name>')`.
- Every other specifier of the package is refused as `not_importable`: the bare name, a skill or
  module not listed, a dotted path. None of them falls through to Node's own resolution, so a
  `node_modules` folder the workspace holds can never stand in for the built-in module.
- Every other specifier goes to Node's own resolution, unchanged.

A refusal prints one JSON line, `{ "error", "message" }`, on stderr and exits 1, the shape the
command line uses. There is no stack and no `data:` URL in the output. The skills directory is
embedded as a JSON string, so a path with quotes or commas is carried exactly.
`module.registerHooks` runs in the script's own thread (Node 22.15 and later; the platform requires
Node 24), so it needs no worker, which `--permission` would refuse.

`tests/engine/run-skill-script.test.ts` fails when a shipped file and `BUILTIN_IMPORTS` differ.
It also fails when a listed file imports a relative file that is not listed, so no unchecked file
is ever loaded. Changing the reader therefore means updating the digests in the same pull request.

**The grant is checked before a run too.** `builtinImportProblems` in `use-cases/kit/contract.ts`,
run by every entry's contract tier ("grants every built-in skill its scripts import"), reads each
of an agent's own skills' scripts. It fails when one imports
`@indx-workspace/builtin-skills/<name>/` and the agent does not grant `builtinSkill('<name>')`.

**Only `run_skill_script` installs the hook.** A script started some other way, for example
through `Bash` on an engine that offers a shell, cannot resolve the package path. Use cases run
their scripts through `run_skill_script`, and a read-only grant leaves no other way to run them.

### D4 — Proof in both places, and the floor

- In the repository: `use-cases/kit/builtin-modules.test.ts` imports both modules by package path
  under the use cases' own TypeScript and Vitest settings. The budget does not count a package
  import (`use-cases/kit/budget.ts`), and dependency-cruiser's package-name rule holds as it is,
  with no exception.
- In a run: `tests/engine/run-skill-script.test.ts` places the shipped `office-reader`
  (`builtinSkillFiles`) beside a script that is only its calculation, and runs it through
  `runSkillScript` under `--permission`. It also proves four refusals. A workspace
  `node_modules/@indx-workspace/builtin-skills` is never loaded. An ungranted skill is
  `builtin_skill_not_granted`. A placed `office-reader` with one file edited is
  `builtin_skill_modified`. Every other path is `not_importable`. Each refusal is a single JSON
  line.
- `vitest.coverage.config.ts` holds every `office-reader/scripts/lib/**/*.mjs` file at 100% lines,
  branches, functions and statements (`perFile`), as it holds `office-writer` (ADR-0167 D8).

## Consequences

- An AN entry's script is its calculation: about 60 lines instead of about 100. Every entry gets
  the same strict CSV rules and can read `.xlsx`, dates included. The budget entry moves to the
  reader in a follow-up, and so does the AN template's `SKILL.md` contract. Changing the template
  changes the bytes the generator recomputes for every AN entry, so it goes with that migration.
- `run_skill_script`'s command line gains one argument. Each adapter host passes it through
  unchanged, because the argument is built in `packages/engine`.
- `readXlsx` output gains `dates`, `errors` and `date1904`, and an error cell's value is its text.
  The office-reader `SKILL.md` describes both.
- The office-reader bundle grows by the two modules, about 550 lines.
- Shift_JIS CSV is not read. An export in Shift_JIS is refused as `not_utf8` with a message to save
  it as UTF-8. A use case that must read one asks for a new decision. Guessing the encoding is
  ruled out.
- A second module a use case would import (a chart spec) follows the same path: a file under a
  built-in skill's `scripts/lib/`, an export in the package, an entry and digests in
  `BUILTIN_IMPORTS`, and a floor in the coverage config.

## Related decisions

- [ADR-0137](0137-skill-scripts-run-without-a-shell-under-nodes-permission-model.md): how a skill
  script runs, and what it may read and write.
- [ADR-0167](0167-office-files-are-written-from-a-typed-model-by-a-built-in-skill.md): the second
  built-in skill, its `scripts/lib/` layout and its coverage floor.
