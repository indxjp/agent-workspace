---
changelog: platform
section: Fixed
---

- A `file://` storage connection's listing carries one walk from page to page, so a run's delivery reads each folder once and logs what it skipped once, and a walk that examines more than 200,000 directory entries stops with a typed `FolderWalkLimitError` instead of reading a huge folder to the end (#1835).
