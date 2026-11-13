---
changelog: app
section: Added
---

- `@indx-workspace/app/react`: `ResourceList`, `ResourceBoard`, `ResourceForm` and
  `ResourceDetail`, a resource's four pages, each driven by its `defineResource` result alone. The
  list is a table with one column per field, filters from its `enumOf()`, `person()` and `date()`
  fields and cursor paging; the board has one column per value of an `enumOf()` field, each card a
  link to the detail; the form has one labelled control per field, checks the draft with the
  resource's create or update schema, and puts a server problem on the fields its `details` name
  or in an alert with a way to try again; the detail shows every field, `ref()` links, `files()`
  as read-only attachment chips, and a history and an `aside` slot. Every string is in `ja` and
  `en` (`appStrings`).
- `resourceClient(resource, { baseUrl, fetch })` with `list`, `get`, `create` and `update` against
  the resource's routes, parsing every answer with the record schema; a failure is one typed
  `ResourceProblemError { code, status, fieldErrors, formErrors }`.
- `AppTheme`, the `.aw-app` root themed by `surfaceThemeStyle` from `@indx-workspace/react/theme`,
  and `@indx-workspace/app/react/styles.css`, which reuses the surface's custom properties.
- The package now depends on `@indx-workspace/react` and takes `react` (`^18.3.0 || ^19`) as a
  peer.
