---
changelog: platform
section: Added
---

- Agent-team runs keep their tree bounded and stoppable (spec 04 §5.18, #1517). A member call
  whose lead is no longer `running` starts no child: the run start answers
  `409 parent_run_stopped` and the lead sees `team_member_refused`. A member call that is waiting
  interrupts its child as soon as the lead stops and answers `team_member_cancelled`. A child's
  approval continuation counts against its root's 16 children, so a decision over the limit
  answers `409 team_member_limit` and the child stays paused. A scoped credential cannot decide an
  approval on a team lead run (`403 token_out_of_scope`), as it cannot start one.
