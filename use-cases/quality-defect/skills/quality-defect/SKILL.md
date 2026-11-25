---
name: quality-defect
description: How to find past incidents like a new defect and rank their causes with this skill's script (run_skill_script, analyse.mjs), and how to read what it prints.
---

# Past incidents and likely causes

Every report number, count and ranking comes from the script. Never count, sort or filter the
reports in your head, and never write a cause or a fix the script did not print.

Run it with `run_skill_script`. There is no shell. The first argument is the export's `path` as
`search_files` returned it; then `--symptom` as the request writes it, `--process` when the
request names one, and `--fmea` with the FMEA workbook's path when the process is the press
(プレス / press):

```json
{
  "skill": "quality-defect",
  "script": "analyse.mjs",
  "args": [
    "quality-defect/ja/QMS_不具合報告_書き出し.csv",
    "--symptom",
    "バリ",
    "--process",
    "プレス",
    "--fmea",
    "quality-defect/ja/プレス工程FMEA.xlsx"
  ]
}
```

It keeps the past reports of the same symptom (and process), compared without case, and prints:

- `causes`: the cause classes of those reports, most reports first (then the newest), each with
  its `fourM` (人・機械・材料・方法 / man, machine, material, method), the number of `incidents`,
  the `pieces` affected, whether one of them `recurred`, and the report numbers;
- `incidents`: the reports, newest first, with the date, part, cause class, the cause as written
  (`detail`) and the fix taken (`fix`);
- `fourM`: the number of reports per 4M; `fmea`: the FMEA rows of that failure mode and process,
  with the current control and the RPN; `matched`: how many reports it kept.

When `matched` is 0 there is no similar past report: say so and that the quality team registers it
as a new defect. When it cannot read the file it prints `{ "error", "message" }`: say what it says.

## What the ranking means

The ranking is how often a cause was found before for this symptom; it is a list of candidates to
check, not the cause of the new defect. A cause marked recurred came back after its fix: say 再発 /
recurred, and suggest checking whether that fix is still in place. The person who investigates the
new lot decides.
