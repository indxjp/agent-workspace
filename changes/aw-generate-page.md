---
changelog: aw
section: Added
---

- `aw generate resource` also writes the resource's three pages from the app kit's parts, each a
  few lines: `app/<plural>/page.tsx` (`ResourceList`, or `ResourceBoard` with `--board`),
  `app/<plural>/[id]/page.tsx` (`ResourceDetailLoader`) and `app/<plural>/new/page.tsx`
  (`ResourceForm`). They are recorded in the resource's `aw-generated.json` entry, so
  `aw destroy resource` removes them too.
- `aw generate page <name> --kind dashboard|list|custom [--resource <resource>]` writes
  `app/<name>/page.tsx`: a placeholder dashboard, a list of `--resource`, or an empty page of your
  own. It refuses an unknown `--kind`, a list page without an existing resource, and a name that is
  a resource's plural (`app/<plural>/` holds that resource's pages). `aw destroy page <name>`
  removes it.
