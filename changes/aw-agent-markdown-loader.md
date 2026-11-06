---
changelog: aw
section: Added
---

- The project loader behind `aw check`, `aw push` and `aw dev` now reads `agents/*.agent.md` (the
  ADR-0133 interchange file, which an app blueprint ships its agents as) beside `agents/*.ts`
  (ADR-0166 D12). The file is parsed, never run as code. A name defined both ways is refused as
  `agent_defined_twice`, a conversion that would drop a field as `agent_conversion_lossy`, and a
  bad file, or one whose agent name differs from its file name, as `agent_markdown_invalid`. A
  project whose only agents are `.agent.md` files is now valid.
