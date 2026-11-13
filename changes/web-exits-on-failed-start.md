---
changelog: platform
section: Changed
---

- `web` exits with status 1 when its start fails, instead of listening and answering 500 to every
  request. An invalid `AW_DEPLOYMENT_POLICY`, `AW_DEPLOYMENT_FEATURES`, `AW_TRUSTED_PROXY_HOPS` or
  `AW_CONTAINER_IDLE_STOP_SECONDS` is the usual cause: the log line names every refused variable at
  once, so one restart fixes them all. A container platform now shows the server as crashed or
  restarting, with the reason in its log. A missing `SESSION_SECRET` or an unreachable database
  still starts and answers 503 with the reason. `startWeb` (the embedded workspace) rejects with
  the error instead of exiting its caller's process.
- The gateway's start-up log lists every refused variable in full. Before, the list was cut at 200
  characters, so with three or more invalid settings the later ones were missing.
