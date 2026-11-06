---
changelog: contracts
section: Added
---

- `RunResourceSchema.parentRunId` (`null` for a root run), and `RunDetailSchema` /
  `RunDetailResponseSchema` for `GET /api/runs/:id`: the run plus `children` (at most
  `RUN_CHILDREN_MAX`, 16) and `treeCost` (`RunTreeCostSchema`), both optional on the read so a
  control plane that predates run trees still parses (ADR-0104 acceptance, #1516). The route
  catalogue gains the six `agentTeams.*` routes, and `runs.get` answers `RunDetailResponseSchema`.
