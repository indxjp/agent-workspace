---
changelog: platform
section: Added
---

- The marketing site (lp.agentworkspace.indx.jp) introduces the Agent Store: its live agents by area
  of work, how a store agent is tried, customized and installed, an agent's listing, the example
  apps' handwritten line counts and the seven docs chapters in order. Its entries, counts and line
  counts are read from the store catalog when the site is built (`scripts/sites/store-data.mjs`).
- The marketing site has a Japanese version under `/ja/`, built from the English pages and the
  strings in `sites/lp/_i18n/ja/` (`scripts/sites/i18n.mjs`); a header switch moves between the
  two, and `tests/sites/i18n.test.ts` fails when an English string has no Japanese one.
