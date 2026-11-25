---
changelog: platform
section: Security
---

- A demo copy's approval gates now follow its stand-ins by id. A stand-in that cannot keep the
  template connector's name (`tracker-incident` when another entry's stand-in holds `tracker`,
  ADR-0171 D3) kept a gate written on the old name, which matched none of its tools, so the write
  it guarded (the incident entry's `create_task`, the meeting minutes entry's `createTask`) ran
  without waiting for a person. The copy now writes each gate on the stand-in's id, and compose
  points a gate written on a connector's id at the connector's key in the run, as it already did for
  tool rules.
