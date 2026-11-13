---
changelog: platforms
section: Changed
---

- An ejected Claude Agent SDK project's skills are now in `workspace/.claude/skills/`, the agent's
  working directory, instead of `.claude/skills/`. `src/agent.ts` creates `workspace/` on start.
