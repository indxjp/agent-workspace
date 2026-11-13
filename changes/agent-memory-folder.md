---
changelog: platform
section: Added
---

- An agent may keep a memory folder across sessions (ADR-0163, #1526).
  `permissions.memory: 'agent'` (`defineAgent({ permissions: { memory: 'agent' } })`), in force
  while `readFiles` and `writeFiles` are both on, hands the run the workspace folder `memory/<agentId>/` read-write at
  `memory/`, and a completed run writes its `memory/` back there: at most 64 files and 256 KiB
  (`memory_limit_exceeded` otherwise), symlinks refused, only new or changed files, nothing deleted.
  Each run that wrote leaves one `memory-updated` audit row naming the run (migration 0100). The
  Claude adapter adds one system-prompt line naming `memory/MEMORY.md`. A member reads and deletes a
  fact in the file browser, and the next session is not handed it. An agent without `memory` is
  unchanged. The folder belongs to the agent, not a person: every person who runs the agent reads
  what any earlier run wrote there, another person's facts and any saved injected instruction
  included. Per-person memory waits for #1281.
