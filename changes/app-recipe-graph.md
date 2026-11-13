---
changelog: app
section: Added
---

- `recipeRoutes(app)` from `@indx-workspace/app/server`: the recipe routes of four one-line route
  files. `GET /api/recipes/runs?recipe=&status=&cursor=` pages the workspace's recipe runs (ADR-0079
  shape), `GET /api/recipes/runs/:id` answers a run with its steps (each step's console run link,
  cost and pending call read from Agent Workspace as the person), and
  `POST /api/recipes/runs/:id/steps/:key/decision` approves or rejects a waiting step with the
  person's own token, so the platform's refusal (`403`, `approval_already_decided`,
  `approval_expired`, `run_not_awaiting_approval`) comes back by its code. Another workspace's run
  is `404 recipe_run_not_found`, and a step that does not wait is `409` with the code
  `recipe_step_not_awaiting_approval`.
- `POST /api/recipes/webhook` verifies a run-outcome webhook (N-3) with `AW_APP_WEBHOOK_SECRET`,
  refuses an unsigned, forged or stale delivery with `401 webhook_unverified`, and wakes the steps
  waiting on the run; polling with `follow` stays the fallback.
- `RecipeGraph` and `RecipeRunList` from `@indx-workspace/app/react`: a run's steps as a vertical
  list with connectors (key, status, duration, cost, run link; Approve and Reject on a waiting
  step), polled every 2 s until the run stops and announced in a polite live region, in `ja` and
  `en`; and the page of recipe runs. `recipeClient()` is their way to the routes.
- `aw-app recipe-on '<cron>' [--tz <iana>]` checks a recipe's schedule as `defineRecipe` does, for
  `aw generate recipe`.
- `RecipeStore.listRuns` takes `recipe` and `status` filters; a cursor is bound to them.
