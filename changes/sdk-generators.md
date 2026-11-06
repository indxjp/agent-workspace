---
changelog: sdk
section: Added
---

- The generators' pure half in `@indx-workspace/sdk/project`, for `aw generate app|resource|agent`:
  `parseFieldSpec` and `parseFieldSpecs` read the `name:type` field grammar (`title:text(200)`,
  `amount:money(JPY)`, `status:enum(new,closed)`, `parent:ref(ticket)`, a trailing `?` for an
  optional field) and refuse a bad argument with every reason; `renderFieldCode` writes the
  app-kit builder call a field becomes; `GENERATOR_FIELD_TYPES` lists the field types.
  `renderAppSpec`, `renderResourceSpec` and `renderAgentSpec` give the values of the `app`,
  `resource` and `agent` templates, which `renderGeneratorTemplate` renders.
- `aw-generated.json`, the record of what a generator wrote: `parseGeneratedManifest` refuses a
  file that is not exactly the manifest, `serializeGeneratedManifest` writes it in one canonical
  form, and `addGeneratedEntry` and `removeGeneratedEntry` change it.
