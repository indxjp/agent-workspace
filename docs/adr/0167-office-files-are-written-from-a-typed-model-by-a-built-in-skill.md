# ADR-0167 — Office files are written from a typed model by a built-in skill

Status: accepted
Date: 2026-11-21
Decided by: the implementing agent of G1 (tracker #2383, the use-cases-100 plan), within the Owner's decision of 2026-11-21 (docx, pptx and xlsx in G1, from a typed model)
Scope: `packages/skills-office/office-writer/` (new), `packages/skills-office/src/` (tests and the bundle), `packages/contracts/src/skills.ts` (registration), `vitest.coverage.config.ts` (the coverage floor)

## Context

Fourteen of the hundred use cases in the use-cases-100 plan (SSOT §9 G1) end in an Office file: a
proposal deck, a work instruction, a privacy assessment, a translated document that keeps its
layout, a handover note. The Owner decided on 2026-11-21 that G1 writes `.docx`, `.pptx` and
`.xlsx` together, from a typed document model, not by converting free-form HTML.

### What exists

- **`office-reader`** (`packages/skills-office/office-reader/`) is the platform's one built-in
  skill (`BUILTIN_SKILL_NAMES` in `packages/contracts/src/skills.ts`). Its scripts are plain
  JavaScript that runs with Node alone: a run's sandbox has Node, and a skill cannot bring npm
  packages with it. `scripts/bundle.mjs` copies every directory of the package that holds a
  `SKILL.md` into `src/skills.json`, which the web server installs into a workspace on demand
  (`apps/web/server/skills/builtin.ts`).
- **`ooxml.mjs write`** in `office-reader` writes a `.xlsx` or `.docx` from `{ sheets }` or
  `{ paragraphs }`. It exists for test fixtures: no styles, no lists, no tables in Word, no
  validation, and it overwrites whatever is at the output path.
- **`run_skill_script`** ([ADR-0137](0137-skill-scripts-run-without-a-shell-under-nodes-permission-model.md))
  runs a skill's script under Node's permission model. The script may write only where the agent
  may write: its read-write grants and `outputs/`, and only for a `writeFiles` agent. The adapters
  do not pre-approve the tool, so each call waits for approval unless the agent's author lists it
  in `autoApprove`. Files under `outputs/` are collected into the run's record.

## Options

### Option A — A second built-in skill, `office-writer`, that writes from a typed JSON model (recommended)

The agent writes a JSON model of the document, then calls one script that validates it and writes
the Office file. The model has the parts the use cases need and nothing else: headings,
paragraphs, lists and tables for Word; slides with a title, bullets and an optional table for
PowerPoint; sheets of typed cells for Excel.

### Option B — Grow `office-reader`'s `write`

One skill would both read and write. A grant of the skill would then give an agent a writer
whenever it was given a reader, and the reader's `SKILL.md` would grow past what an agent needs to
read a file. The fixture writer's loose input would also have to stay compatible. Rejected.

### Option C — Convert HTML or Markdown

Free-form markup has no fixed mapping to slides or cells, so the result would depend on the
converter's guesses, and the Owner ruled it out. Rejected.

### Option D — A library such as `docx`, `pptxgenjs` or `exceljs`

A skill cannot bring npm packages into the sandbox, and vendoring a library into the skill would
put tens of thousands of unreviewed lines into every workspace. Rejected.

## Recommendation

Option A, with the decisions below.

### D1 — One script, three formats, one model per file

`office-writer/scripts/write.mjs <model.json> <out.docx|out.pptx|out.xlsx>`. The model's
`format` field names the format and must match the output's extension, or the call is refused as
`extension_mismatch`. On success the script prints `{ "written": "<out>", "bytes": <n> }`. The
modules it imports live in `scripts/lib/`, so `run_skill_script`, which offers only the direct
children of `scripts/`, lists `write.mjs` as the skill's one script.

### D2 — The model

```text
docx  { format, title?, blocks: Block[] }
      Block = { type: "heading", level: 1..6, text }
            | { type: "paragraph", text }
            | { type: "list", ordered?, items: string[] }
            | { type: "table", header?: string[], rows: (string | number)[][] }
pptx  { format, slides: [{ title, bullets?: string[], table?: { header?, rows } }] }
xlsx  { format, sheets: [{ name, header?: string[], rows: Cell[][] }] }
      Cell = string | number | boolean | null | { date: "YYYY-MM-DD" }
```

Unknown keys are refused, as for every owned contract. A line break in text (CRLF, CR or LF) is
kept as one break (a `<w:br/>` in Word, an `<a:br/>` in PowerPoint, the character itself in a
cell). A Word or slide table's rows are as wide as its header, or as its first row without one. A
sheet's name follows Excel's rules: 1–31 characters, none of `[]:*?/\`, no tab or line break, not
starting or ending with `'`, not `History` in any case (Excel reserves it), and unique ignoring
case. Characters XML 1.0 cannot carry are refused, not dropped.

### D3 — Validation is a dependency-free validator in the script, not zod

The sandbox cannot load zod, and the model arrives from the agent, so it must be checked where it
is read. `scripts/lib/model.mjs` checks the model by hand and reports the issues it finds in one
pass (up to 50), each with a JSON path (`$.slides[2].table.rows[0]`), so the agent can repair the
model in few steps. An object with a wrong field is not looked into further. The engineering
guideline asks for zod where a contract is reused across TypeScript packages. This contract has no
TypeScript consumer outside the skill's tests, which type it through `model.d.mts`. If a TypeScript
package comes to build models, its zod schema belongs in `@indx-workspace/contracts`, and a test
must hold that schema and this validator to the same accepted and refused models.

### D4 — Limits

The model file is at most 8 MiB. A text is at most 32,767 characters (Excel's cell limit, applied
everywhere). A document holds at most 5,000 blocks, a list at most 1,000 items, and a table at most
1,000 rows and 32 columns. A deck holds at most 200 slides, a slide at most 20 bullets, and a
slide's table at most 15 rows and 8 columns: more does not fit on a slide. A workbook holds at most 64 sheets, a sheet at most 16,384 columns,
and a workbook at most 1,000,000 cells. Each limit is refused by name (`model_too_large`, or an
issue of `invalid_model`), never truncated. The model's byte limit also bounds the output: every
written byte comes from a byte of the model, so no file nears the 4 GiB a zip without Zip64 holds.

### D5 — The written file is only as permitted as `run_skill_script` is

The script adds no write path. It writes through `run_skill_script`, which waits for approval
(ADR-0137) and lets the script write only to `outputs/` or a read-write grant. The script creates the
output's folder, and refuses an output path that already exists (`output_exists`), so an approved
call never replaces a file the approver did not see. It opens the output exclusively (`wx`), and if
the write then fails it removes the file, so no truncated file is left. It reads the model through
the one descriptor whose size it checked. The `SKILL.md` tells the agent to write under `outputs/`,
which the run collects as its result.

Approval is per tool, not per script, and the approval card shows the call's arguments: the model's
path, not the document. An agent that lists `run_skill_script` in `autoApprove`, for example to
read files with `office-reader` without a prompt, also writes Office files without one. A use case
that grants `office-writer` therefore keeps `run_skill_script` out of `autoApprove`. G1 enforces
neither; issue #2388 proposes showing a summary of the document in the approval, and refusing
`autoApprove` of `run_skill_script` when `office-writer` is granted.

Amended by #2420. For the `claude-agent-sdk` engine, a grant of `office-writer` now also denies
`Write` and `Edit` under `<cwd>/outputs/**` (`claudeOfficeWriterOutputDenials`). The agent can still
write its model with `Write` elsewhere in its session folder without asking, but a deliverable
reaches `outputs/` only through the approved `office-writer` script, which writes under Node's
permission model. The other engines (Mastra, OpenAI Agents, Pi) still rely on the shared path check
in `@agent-workspace/engine`, which has no such rule. Issue #2421 tracks adding it there.

### D6 — The files open in Office and LibreOffice

Each file carries the parts the applications require, beyond what a reader needs:

- **Word:** `styles.xml` defines `Normal`, `Title`, `Heading1`–`Heading6` (with outline levels, so
  the navigation pane and a table of contents see them), `ListParagraph` and `TableGrid`.
  `numbering.xml` defines a bullet list and a numbered list; each numbered list restarts at 1. The
  page is A4. A table has fixed column widths, a repeating header row, and an empty paragraph after
  it, so two tables never merge.
- **PowerPoint:** one slide master, one blank layout and a theme, as the format requires. Each
  slide is 16:9, with its title as a title placeholder, so the outline view and screen readers find
  it. Bullets and the table sit in positioned shapes below the title; with both, the bullets take
  the upper 40%. A table has borders, a shaded header row, and rows 0.45 inch high while they fit.
- **Excel:** `styles.xml` with a bold header style and a date style (custom number format 164,
  `yyyy-mm-dd`, so the display does not depend on the reader's locale). A header row is frozen. A
  date cell is stored as its serial day number. Each column is as wide as its widest value (8 to 60
  characters, a full-width character counting two), so a date never shows as `###`.
- **All three:** a number in a Word or slide table is right-aligned. The same model always gives
  the same bytes (a fixed zip time stamp).

The zip writer (`scripts/lib/package.mjs`) is the skill's own: a skill is installed alone, so it
cannot import `office-reader`'s scripts. It uses `zlib.crc32` (Node 22.2 and later; the platform
requires Node 24).

### D7 — Registration

`scripts/bundle.mjs` bundles every skill directory, so `builtinSkillFiles('office-writer')` holds
the skill's files. `BUILTIN_SKILL_NAMES` in `packages/contracts` lists `'office-writer'`, so a
definition names it with `builtinSkill('office-writer')` and the control plane installs it on
demand, as it does `office-reader`.

### D8 — The scripts stay at 100% in CI

`vitest.coverage.config.ts` (the critical-packages coverage floor) runs the skills-office tests and
holds every `office-writer/scripts/**/*.mjs` file at 100% lines, branches, functions and statements
(`perFile`). The type declarations (`.d.mts`) are not measured.

## Consequences

- Fourteen use-case entries can deliver an Office file as the run's result, and an eval can read it
  back with `office-reader`.
- `@agent-workspace/skills-office` ships a second skill. The bundle grows by the writer's scripts.
- The model is deliberately small. Fonts, colours, images, merged cells, formulas and charts are
  not written. A use case that needs one asks for a new decision instead of growing the model ad
  hoc.

## Proof

`packages/skills-office/src/office-writer.test.ts` and `office-writer-model.test.ts`, with
`index.test.ts` for the bundle:

- A document, a deck and a workbook, each written and read back through `office-reader`
  (`readDocx`, `readXlsx`, and `readZip` for the slides, which `office-reader` has no reader for).
  The text, the heading styles and every table cell come back.
- Every part a file declares in `[Content_Types].xml` and every relationship target is in the zip,
  and every XML part is well formed (each element closes in order, each `&` starts an entity).
- By hand, before merge: the three sample files open in LibreOffice 24 and convert to PDF with their
  text, lists, numbering and tables in place. Microsoft Office was not available to check.
- Each refusal by name: `invalid_json`, `invalid_model` (with its issue paths), `unreadable_model`,
  `model_too_large`, `extension_mismatch`, `output_exists` and `output_not_writable`, with nothing
  written and an existing file left as it was, and the usage exit code 2. A write that fails after
  the exclusive open leaves no file.
- 100% line, branch, function and statement coverage of each `office-writer/scripts/` file, held by
  the coverage floor (D8).
- `packages/contracts/src/skills.test.ts`: `BUILTIN_SKILL_NAMES` is `office-reader` and
  `office-writer`, both valid skill names.

## Related decisions

- [ADR-0137](0137-skill-scripts-run-without-a-shell-under-nodes-permission-model.md) — how a skill
  script runs, where it may write, and its approval (D5).
