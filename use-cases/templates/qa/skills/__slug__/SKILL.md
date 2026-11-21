---
name: __slug__
description: How to write an answer grounded in the granted documents, its citation format and the not-found sentence.
---

# Answers with citations

- Write the conclusion in one or two sentences, then the facts behind it as bullets.
- End every fact with its citation: 〔document title, section〕 in Japanese, [document title,
  section] in English. Use the title and section exactly as the document writes them.
- Write no sentence without a citation. When two documents disagree, show both with their
  citations and say which one is newer.
- When nothing in the documents answers the question, answer with this sentence and nothing else:
  - ja: 「資料に該当する記載が見つかりませんでした。」
  - en: "The documents do not cover this."

## When the run asks for a typed answer

Put the whole answer, citations included, in `answer`; each source in `citations` as `path` (the
`path` that `search_files` returned), `title` and `section` as the document writes them; and
`answered` false, with no citation, when you gave the not-found sentence.
