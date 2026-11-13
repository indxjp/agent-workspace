---
changelog: platform
section: Fixed
---

- A file audit row is written once per event even when its write is retried: each row carries an
  audit key (the stored object for an upload, the file for a delete, the request for a download,
  link or move), and a retried upload completion records an upload whose first audit write failed.
  Every download request, a `Range` request included, stays its own `file-downloaded` row.
