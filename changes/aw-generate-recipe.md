---
changelog: aw
section: Added
---

- `aw generate recipe <name> --on resource:<resource>.<created|updated|deleted>` and
  `aw generate recipe <name> --on 'schedule:<cron>' [--tz <iana>]` write exactly
  `recipes/<name>.ts` (a `defineRecipe` with one example step) and `tests/recipes/<name>.test.ts`
  (a `recipeHarness` test that passes as generated), and add the recipe to `recipes: [...]` in
  `app.config.ts`. A resource the app does not have, or a cron or time zone the project's
  `aw-app recipe-on` refuses, is a usage error; `trigger:<name>` is not available yet.
  `aw destroy recipe <name>` removes both files and reverts the `app.config.ts` edit, and refuses a
  file edited since it was generated. The SDK's `renderRecipeSpec` and the `recipe` template back it.
