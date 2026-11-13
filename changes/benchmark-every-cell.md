---
changelog: platform
section: Changed
---

- All four reference apps under `examples/` (team chat, wiki, CRM and service desk) now score
  every cell of the benchmark in `examples/README.md` (#1476): Generated, Handwritten budget,
  Journeys, Agent on data, Self-host and No fork. Their journeys sign a person in under `aw dev` at
  its development issuer and act as that person, call the app connector from a claude-agent-sdk
  run, and move a schedule slot with the app kit's test clock. Self-host is measured by the
  `apps-e2e` CI job, which boots each app with Docker Compose.
