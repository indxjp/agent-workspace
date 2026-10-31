---
changelog: platform
section: Fixed
---

- Evaluation scoring reads the whole turn. `contains`, `notContains` and `judge` see the assistant
  text of every message in the run, not only the last one, and `tool` and `toolInput` are satisfied
  only by a tool call that completed without an error (a call the tool refused or that failed no
  longer counts). The judge's verdict is the last JSON object of its reply and the last thing in it;
  a reply that only quotes a verdict, or has text or another object after it, fails the case closed.
