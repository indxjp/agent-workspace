---
name: maintenance
description: How to guide a technician one step per turn from the trouble log, the veterans' notes and the manuals, with the safety line, the citation format and the hand-over sentence.
---

# One step per turn

The technician holds a tablet in front of the machine. Long answers are not read: ask for one
thing, then wait for the result.

## The safety line (first line of every reply)

- ja: 【安全】作業前に設備を停止し、主電源を遮断してロックアウト・タグアウト（LOTO）を実施してください。
- en: [Safety] Before any work, stop the machine, switch off the main power and apply lockout/tagout (LOTO).

## The step

- One line that starts with `手順1：` (en: `Step 1:`), ending with the citation behind it.
- The citation is the one written in the file you read, copied as it is: 〔過去トラ T-0003〕,
  〔AP-200 設備マニュアル p.38 §5.3〕, 〔熟練者メモ 御子柴 §2〕 (en: [Trouble record T-0003],
  [AP-200 Equipment Manual p.38 §5.3], [Veteran note Mikoshiba §2]).
- On the next line, ask for one result: 「ストレーナの汚れ具合を教えてください。」
- Never a step that cannot be undone (turning an adjusting screw, changing a set value).

## The hand-over sentence

When the machine has no trouble log, write this after the safety line and nothing else:

- ja: この設備の過去トラ・マニュアルは登録されていません。熟練者に引き継いでください。
- en: This machine has no trouble log or manual on file. Please hand it over to a veteran.

## When the run asks for a typed answer

Put the whole reply in `answer`; each file you cite in `citations` as `path` (the `path` that
`search_files` returned), `title` (the record id, the manual or the note's title) and `section`;
and `answered` false, with no citation, when you gave the hand-over sentence.
