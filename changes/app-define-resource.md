---
changelog: app
section: Added
---

- `defineResource` and `defineApp`, with `isDefinedResource` and `isDefinedApp`: a portal app's
  resources and the app itself, validated when the file loads. A refused definition throws the
  SDK's `DefinitionError` listing every reason at once; an accepted one is frozen and branded.
- The field builders `text`, `richText`, `number`, `money`, `bool`, `date`, `dateTime`, `enumOf`,
  `person`, `ref`, `files` and `tags`. Each carries its column, value schema, form control, list
  cell and agent-tool schema as plain data. This `files()` is a record attachment field, not
  `@indx-workspace/sdk/define`'s agent file grant.
- `createInputSchema`, `updateInputSchema` and `recordSchema`: the Zod schemas of a resource's
  create body, update body and record, built from its fields.
