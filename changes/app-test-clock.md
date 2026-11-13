---
changelog: app
section: Added
---

- A test clock and a schedule-slot trigger (issue #2077, ADR-0164 amendment). `testClock()` from
  `@indx-workspace/app/testing` is a clock a test moves by hand; `recipeRunner({ clock })`,
  `serveRecipes(app, env, { clock })` and `recipeHarness(recipe, { clock })` read it, and
  `runner.fireSlot(recipe, at)` / `harness.fireSlot(at?)` start one slot of a schedule at a chosen
  instant with the schedule's own dedupe key. Generated apps gain
  `app/api/recipes/slots/route.ts` (`recipeRoutes(app).slots`): a signed-in Owner or Admin of a
  development app starts a slot with `POST /api/recipes/slots` `{ recipe, at }`. Under
  `NODE_ENV=production` the route answers `404` and `serveRecipes` refuses a clock with
  `clock_override_refused`; production schedules are unchanged.
