---
changelog: platform
section: Added
---

- `docs/operations/settings.md` lists the variables web and the egress proxy read at start-up, with
  what applies when each is unset. It is generated from each settings module's own list, and
  `pnpm docs:check` fails when the two differ.
