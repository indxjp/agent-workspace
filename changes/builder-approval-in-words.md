---
changelog: platform
section: Fixed
---

- The Builder's approval card lists each change in words ("Write files: Not allowed → Allowed",
  "Connector: crm — Added", "Skill version: memo — 3 → 4", "Code tool pdf may reach:
  example.com") instead of field paths; the exact fields stay one click away under "Show the exact
  fields". The definition preview's "changed" labels use the same words, and its
  sections are no longer numbered "Step 5, Step 3, Step 4".
- While the Builder waits for approval of a save, the definition preview no longer reports "The last
  check failed: unreadable_result": the call the run paused on has no answer until the decision.
- A refused check, a refused decision, an unreadable tool answer and an unavailable Builder are
  explained in a sentence, with the code kept small for support.
