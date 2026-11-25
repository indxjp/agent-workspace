---
name: manual-search
description: How to answer from the maintenance manuals, the manual/page/section citation and the not-found sentence.
---

# Answers from the manuals, with the page

- Write the conclusion in one or two sentences, then the facts behind it as bullets.
- End every fact with its citation: the manual's `title`, the page and the section, exactly as the
  manual writes them:
  - ja: 〔油圧ユニット保守マニュアル p.12 §3.2〕
  - en: [Hydraulic Unit Maintenance Manual p.12 §3.2]
- The page is the `page` that `search_files` returned for a PDF, and the last `<!-- page N -->`
  marker above the section for a Markdown manual.
- Write no sentence without a citation. A condition in the same section ("whichever comes first",
  "replace at once when …", an approval) belongs in the answer.
- A note that is not a numbered section (a margin note, a handwritten remark) is not a rule: never
  cite it as one.
- When two manuals disagree, show both with their citations and say which was revised later.

## When the manuals do not answer

Answer with this sentence and nothing else, in the language of the question:

- ja: 「該当する記載が見つかりませんでした。設備保全課（内線 4410）にお問い合わせください。」
- en: "The manuals do not cover this. Please ask the Equipment Maintenance Section (ext. 4410)."

## When the run asks for a typed answer

Put the whole answer, citations included, in `answer`; each source in `citations` as `path` (the
`path` that `search_files` returned), `title`, `page` and `section` (`§3.2`) as the manual writes
them; and `answered` false, with no citation, when you gave the not-found sentence.
