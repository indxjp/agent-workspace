---
changelog: platform
section: Changed
---

- The runner manager reads its settings in one module, `apps/runner/src/manager-settings.ts`, and
  its variables are now in the generated settings table (`docs/operations/settings.md`). A failed
  start logs one JSON line with each refused setting in its own `refused` entry and exits with
  status 1; the same happens for the Vercel Function entry, which answers 500 as before. A bad
  `PORT`, a short `RUNNER_MANAGER_TOKEN`, a bad `RUNTIME_VERIFICATION_TIMEOUT_MS` and a bad driver
  setting are named together, so one restart fixes them all.
- `RUNTIME_VERIFICATION_TIMEOUT_MS` must be a whole number of milliseconds from 1. Before, any text
  was passed through `Number()`, so a typo became `NaN` and every sandbox readiness check timed out
  at once. Unset still means 30 seconds.
