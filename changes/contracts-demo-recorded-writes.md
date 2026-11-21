---
changelog: contracts
section: Added
---

- `@indx-workspace/contracts/demo-operator`: the record kinds a demo's records stand-in keeps after
  approval (`DEMO_RECORD_KINDS`: calendar, task, access, booking), their schemas
  (`DEMO_RECORD_SCHEMAS`) and bilingual samples (`DEMO_RECORD_SAMPLES`), `DemoSeedConnector.recorded`
  (which write tool records which kind, read back by which read tool), and the stand-in's answer
  `DemoRecordWriteAnswerSchema` with its codes `demo_record_invalid` and `demo_write_not_recorded`
  (ADR-0169).
