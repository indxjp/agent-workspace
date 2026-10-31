---
changelog: platform
section: Fixed
---

- The Builder looks a run's caller up by principal instead of scanning the workspace's member list
  on every tool call, and an API key bound to a Builder endpoint client no longer fails the whole
  key listing: it is listed and refused at authentication.
