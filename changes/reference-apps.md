---
changelog: platform
section: Added
---

- `examples/` holds four reference apps built only on the published `@indx-workspace/*` packages,
  each generated from its own `commands.sh` by `npm create` and `aw generate` plus a measured
  amount of handwritten code: a team chat (`examples/team-chat`), a wiki (`examples/wiki`), a CRM
  (`examples/crm`) and a service desk (`examples/service-desk`), beside the `examples/minimal`
  fixture (#1476). Each is scored on six cells (Generated, Handwritten budget, Journeys, Agent on
  data, Self-host, No fork); `examples/README.md` holds the scoreboard, and a cell that is not met
  is shown as a gap with its cause.
