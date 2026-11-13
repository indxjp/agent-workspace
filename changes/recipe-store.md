---
changelog: app
section: Added
---

- A recipe reads and writes the app's records with `store(resource)` on its context (ADR-0164).
  It acts as the person's agent, so the person's `access` and the resource's `agents` rule both
  apply, exactly as for an agent tool call; the role comes from the members lookup, with
  `AW_APP_API_KEY` and a 60 s cache. A write is allowed only in the step whose run produced it,
  carries that run's id into the audit row, and is otherwise refused with
  `recipe_write_needs_run`. A schedule acts only in a step given `{ actingFor: <member> }`, whose
  run also asserts that member as `subject`; elsewhere its `store` is refused with
  `recipe_store_needs_person`, and `actingFor` for a non-member or in a recipe with a person is
  `recipe_acting_for_refused`. A store refusal fails the step with the store's own code.
- `recipeRunner` takes `stores` and `members`, which `serveRecipes` fills in from the app's
  stores and `cachedMemberDirectory`, now exported from `@indx-workspace/app/server`.
  `recipeHarness` gives recipes in-memory stores that outlive `restart()`, with `storeOf`,
  `personId` and a `members` option.
