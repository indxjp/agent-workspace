---
changelog: sdk
section: Added
---

- `issuesFromZod(error, prefix?, known?)` from `@indx-workspace/sdk/define`: maps a Zod error to
  the `DefinitionIssue`s a `DefinitionError` lists, naming the closest known key for an unknown
  root key ("did you mean"). `@indx-workspace/app` uses it so its definitions report mistakes in
  the same words as `defineAgent`.
