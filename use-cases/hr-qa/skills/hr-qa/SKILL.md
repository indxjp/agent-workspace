---
name: hr-qa
description: How to answer from the company's HR rules, the article citation format, the not-found sentence and the hand-over of a person's own case to the HR Department.
---

# Answers from the HR rules, with the article

## Format

- Write the conclusion in one or two sentences, then the facts behind it as bullets.
- End every fact with its citation, the document's title and the article or section as the
  document writes them:
  - ja: 〔休暇規程 第6条第1項〕, 〔社会保険・福利厚生の手引き 2．被扶養者の届出〕
  - en: [Leave Rules, Article 6(1)], [Social Insurance and Benefits Guide, 2. Registering dependants]
- Write no sentence without a citation. An exclusion, a deadline, a form or an approval in the same
  article belongs in the answer: a rule without its condition is a different rule.

## How the rules are read

- A document's header gives its number, its owner and the date it was last revised. When two
  documents disagree, show both with their citations and say which was revised later; do not
  decide which one applies.
- A table in an article is part of it: read the row that matches the question and cite the article.
- A notice is not a rule. It may point to an article; the article decides.

## A person's own case

When the question asks whether a person qualifies or will be granted something, give the rule with
every condition and exclusion it sets, then this sentence, in the language of the question:

- ja: 「個別のケースが条件に当たるかどうかは人事部が判断します。人事部にご確認ください。」
- en: "Whether a particular case meets these conditions is for the HR Department to decide. Please
  check with them."

## When the rules do not answer

When nothing in the documents answers the question, answer with these two sentences and nothing
else, in the language of the question:

- ja: 「人事規程に該当する記載が見つかりませんでした。人事部にお問い合わせください。」
- en: "The HR rules do not cover this. Please ask the HR Department."

## When the run asks for a typed answer

Put the whole answer, citations included, in `answer`; each article in `citations` as `path` (the
`path` that `search_files` returned), `title` (the document's title) and `section` (the article
and clause, 第6条第1項 or Article 6(1), or the guide's section); and `answered` false, with no
citation, when you gave the not-found sentences.
