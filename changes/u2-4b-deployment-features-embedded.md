---
changelog: embedded
section: Added
---

- The local runtime sets `AW_DEPLOYMENT_FEATURES` from `start.environment.features`. A hand-set value in `.env` or the environment must be a valid comma-separated feature list (`invalid_value`) naming the same features (`conflicting_value`); with no `features` sent, a valid hand-set value applies with a warning.
