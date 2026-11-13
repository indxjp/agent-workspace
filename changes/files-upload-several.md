---
changelog: platform
section: Changed
---

- The Files screen uploads several files at once: pick more than one, or drop them on the folder
  list. Each file shows whether it is waiting, uploading, uploaded or not uploaded and why, and one
  failure no longer stops the rest. A dropped folder is named and skipped, a file dropped outside
  the list no longer opens in the browser in place of the console, and a file too large for the
  deployment is named with its size and the 64 MiB every deployment accepts (UX-16 in #2086).
