---
changelog: app
section: Added
---

- Recipes (F-2): `defineRecipe({ name, on, input?, run })` with `resourceEvent(resource, event)` and
  `schedule(cron, timezone)` from `@indx-workspace/app`, listed in `defineApp({ recipes })`. A
  recipe is TypeScript the app runs over the SDK; each `step(key, fn)` starts at most one platform
  run with the `Idempotency-Key` `recipe:<recipeRunId>:<stepKey>`, so a recipe executed again after
  a crash never starts a second run for a step.
- `recipeRunner(app, { client, store, workspaceId })` from `@indx-workspace/app/server` executes
  them under a per-recipe-run lease: it memoizes completed steps, records a step's run before it
  waits, suspends on `awaiting_approval` and resumes after `decide()` (the person's own client),
  fails a step with its run's public code only, and dedupes resource events and schedule slots, so
  two replicas firing one slot start one recipe run. `onRunOutcome` takes a verified run-outcome
  webhook and wakes the step waiting on it. `serveRecipes(app)` starts it in the template's
  `instrumentation.ts`; a resource store's new `onCommitted` hook is how it hears of a write.
- `recipe_runs` and `recipe_steps` live in the app's own schema (`recipeTables`, `recipeStoreOf`,
  `createRecipeTablesSql` in `./db`), created by the app template's new second migration
  `0001_app_kit_recipes`; a generated resource's migration is now `0002_…` in a new app.
- `recipeHarness(recipe, { agents })` in `./testing` runs a recipe on `memoryRecipeStore` and a
  scripted platform that honours `Idempotency-Key`, with `crashAfter(stepKey)` and `restart()`.
