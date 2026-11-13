---
changelog: aw
section: Added
---

- `aw generate app <name>` adds the script `image` (`docker build -t <name> .`) to `package.json`
  with the app's `Dockerfile`, and `aw destroy app <name>` removes it while it still runs that
  command. A project that already has an `image` script keeps its own. `package.json` keeps its key
  order through both, so `aw destroy` restores it byte for byte.
