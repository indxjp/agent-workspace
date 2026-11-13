---
changelog: platform
section: Fixed
---

- An agent with Write files on can no longer write `CLAUDE.md`, `.claude/`, or `.mcp.json` in its workspace without approval, since Claude Code loads them as instructions on later runs. The skills editor now quotes YAML frontmatter values, so editing a skill whose description holds a colon no longer breaks it. `agent-workspace start` and `stop` no longer print a malformed `.env` line, which may hold a secret; they name its line number. Blueprint archives with non-ASCII paths are no longer refused. A bad `PORT` is refused, and a failed listen closes Next and the database pools (#2283).
