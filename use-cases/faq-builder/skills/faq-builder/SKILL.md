---
name: faq-builder
description: How to turn an enquiry history into FAQ entries (which tickets become a question, how the answer is sourced, what stays out) and the sections of the FAQ document.
---

# A customer FAQ from the enquiry history

## Which tickets become a question

- Tickets that ask the same thing, in any words, are one question. A question asked in two or more
  tickets becomes one FAQ entry; the entry lists the ticket ids it comes from.
- A ticket about one customer's own matter (their invoice, their contract, their account's data)
  never becomes an entry, whatever the count.
- A ticket still open (`対応中` / `open`), or a question no guide answers, becomes an open point,
  not an entry.

## How an answer is written

- Write the question as a customer would ask it, in one sentence, with no customer's details.
- Answer from the guides only, in their words: the menu names, the periods and the conditions as
  written (`14日間`, `15分`, `日割りの計算はしない`). End the answer with the guide and section it
  rests on: `〔GUIDE-02 3〕` in Japanese, `[GUIDE-02 3]` in English.
- A staff answer is evidence of what customers ask, not a source of the answer. When it disagrees
  with the guide, follow the guide and add an open point: `T-1044 の回答は GUIDE-02 3 と異なる` /
  `T-1044's answer differs from GUIDE-02 3`.

## The document

A Word document with a level-1 title `よくある質問 <product>` / `FAQ: <product>`, then one
level-2 heading per category (in the order the categories first appear in the history), each
question as a level-3 heading with its answer under it, and last a level-2 heading `確認事項` /
`Open points` listing the open points for the reviewer, each with its ticket and guide ids. The
ticket ids appear only in the outline and the open points, never under an answer.
