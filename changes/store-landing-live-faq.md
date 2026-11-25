---
changelog: platform
section: Fixed
---

- Store: the landing copy of every entry that is live, or about to go live, no longer carries an FAQ answer saying the agent is not live yet. The detail page already shows a coming-soon entry's status (its badge and launch-notice section), so the copy no longer repeats it, and `tests/store/landing.test.ts` fails when a live entry's copy says it is not live, in Japanese or English.
