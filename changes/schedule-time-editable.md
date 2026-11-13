---
changelog: platform
section: Added
---

- A schedule's time can be changed in place: the agent page's Schedules tab has **Change time**,
  and `PATCH /api/triggers/:id` takes `cron` and `timezone` for a `schedule` trigger, checked as on
  create. The change restarts the schedule's counting, so no run is owed for the old time
  (ADR-0144 D5). A `webhook` trigger answers `400 invalid_field`. Before, the tab said to delete the
  schedule and add it again.
