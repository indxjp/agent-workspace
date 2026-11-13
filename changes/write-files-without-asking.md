---
changelog: platform
section: Fixed
---

- An agent with **Write files** on can now write files in its workspace. Claude Code asked before
  every `Write` and `Edit`, nobody could answer, so each write was refused ("Did not run: Write"),
  and an agent's memory file was never saved. The switch now allows edits inside the workspace. A
  read-only file grant still keeps its files read-only, a write outside the workspace is still
  refused, and a stored approval rule on `Write` or `Edit` still asks first.
