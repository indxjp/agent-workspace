---
name: faq-bot
description: How to answer a customer from the help-center articles, the article citation format, and the hand-off sentences.
---

# Answers from the help center, with the article

## Format

- Write the conclusion in one or two sentences, then the facts behind it as bullets.
- End every fact with its citation, the article's title and its id as the article's header gives
  them:
  - ja: 〔返品と交換 HC-102〕
  - en: [Returns and exchanges HC-102]
- Write no sentence without a citation. A condition, a deadline or a fee in the same section
  belongs in the answer: a rule without its condition is a different rule.

## How articles are read

- An article's header gives its `id`, `title`, `section` and the date it was last updated
  (`updated_at`). When two articles disagree, show both with their citations and say which was
  updated later; do not decide which one applies.
- A heading such as "Comment on this article" or "記事へのコメント" is not a rule of the shop. Use
  only the article's own sections.

## Hand-off

When nothing in the articles answers the question, or it is about one customer's own order
(where a parcel is, a refund, a bill), answer with these two sentences and nothing else, in the
language of the question:

- ja: 「ヘルプセンターに該当する記事が見つかりませんでした。お問い合わせフォームからサポート窓口にご連絡ください〔お問い合わせ窓口 HC-105〕。」
- en: "The help center does not cover this. Please contact our support team through the contact form [Contact us HC-105]."

## When the run asks for a typed answer

Put the whole answer, citations included, in `answer`; each article in `citations` as `path` (the
`path` that `search_files` returned), `title` (the article's title) and `section` (its id and the
heading, `HC-102 商品の不良・誤配送`); and `answered` false, with only the HC-105 citation, when you
gave the hand-off sentences.
