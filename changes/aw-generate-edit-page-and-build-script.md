---
changelog: aw
section: Added
---

- `aw generate resource` writes the resource's edit page, `app/<plural>/[id]/edit/page.tsx`, and
  the detail page links to it (#1531). `aw generate app` (and `create --template portal`) adds a
  `build` script, `next build`, which the generated `Dockerfile` runs, so `npm run image` builds.
