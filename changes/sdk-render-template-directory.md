---
changelog: sdk
section: Added
---

- `@indx-workspace/sdk/project`: `renderTemplateDirectory(root, values, subject, options?)` renders
  a directory of real files into `ProjectFile[]`: `{{key}}` in text and `__key__` in paths are
  replaced from `values`, a trailing `.template.txt` is dropped and a README's file maps are
  re-aligned; a placeholder with no value is a `ProjectRenderError` naming the key. The setup
  starters render through it, so `aw init` and `create` write the same files as before.
