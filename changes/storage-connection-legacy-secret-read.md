---
changelog: platform
section: Fixed
---

- Browsing, testing or running with a storage connection whose credential was stored by 0.6.11 or
  earlier no longer rewrites it into the target-bound form, which locked undrained older revisions
  out of the connection. The read binds it to the connection's current URL in memory only, and
  still refuses it for a URL the connection no longer has; only creating, editing or rotating the
  connection writes the bound form, as the self-hosting guide says.
