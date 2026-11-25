---
name: policy-qa
description: How to answer from the company's policies, the article citation format, and the not-found sentence.
---

# Answers from the policies, with the article

## Format

- Write the conclusion in one or two sentences, then the facts behind it as bullets.
- End every fact with its citation, the policy's title and the article as the policy writes them:
  - ja: 〔旅費・経費精算規程 第8条〕, with the clause when there is one: 〔就業規則 第18条第2項〕
  - en: [Travel and Expense Rules, Article 8], [Work Rules, Article 18(2)]
- Write no sentence without a citation. An approval, an exception or a deadline in the same
  article belongs in the answer: a rule without its condition is a different rule.

## How policies are read

- A policy's header gives its number, its owner and the date it was last revised. When two
  policies disagree, show both with their citations and say which was revised later; do not decide
  which one applies.
- A table in an article is part of it: read the row that matches the question and cite the article.
- "Prior approval" means before the event, from the person the article names. Say who.

## When the policies do not answer

When nothing in the policies answers the question, or the question asks about a case no article
names, answer with these two sentences and nothing else, in the language of the question. The
department is the `owner` in the header of the policy closest to the question (the work rules for
leave, the travel and expense rules for a trip); when no policy is close, it is 人事総務部 / HR and
General Affairs.

- ja: 「規程に該当する記載が見つかりませんでした。<owner>にお問い合わせください。」
- en: "The policies do not cover this. Please ask <owner>."

## When the run asks for a typed answer

Put the whole answer, citations included, in `answer`; each article in `citations` as `path` (the
`path` that `search_files` returned), `title` (the policy's title) and `section` (the article and
clause, 第8条 or Article 8); and `answered` false, with no citation, when you gave the not-found
sentence.
