---
changelog: platforms
section: Fixed
---

- An ejected Claude Agent SDK project whose agent has **Write files** on can now write files.
  Claude Code asked before every `Write` and `Edit`, the ejected program has nobody to answer, so
  each write was refused. The agent now runs in `workspace/`, its working directory, as Agent
  Workspace runs an agent in its own workspace, and may write only there, with the rule the
  platform's Claude engine uses. Its `CLAUDE.md` and `.claude/` stay read-only, and the program
  beside it (`src/`, `tools/`, `package.json`, `.env`, …) is out of its reach.
