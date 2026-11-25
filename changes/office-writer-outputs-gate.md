---
changelog: platform
section: Security
---

- A Claude Agent SDK agent that grants the built-in `office-writer` skill can no longer `Write` or
  `Edit` a file under `outputs/`. The run's deliverable reaches `outputs/` only through the
  `office-writer` script, whose `run_skill_script` call waits for a person's approval (ADR-0167 D5,
  #2388). Its document model is still written to the session folder without asking.
