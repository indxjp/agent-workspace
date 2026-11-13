---
changelog: platform
section: Fixed
---

- Files: when a rename, move or delete is refused, or a delete stops part-way, the reason now stays
  on screen after the list reloads instead of disappearing at once (#2088). If the list cannot be
  read again after it, the message says the list may be out of date.
