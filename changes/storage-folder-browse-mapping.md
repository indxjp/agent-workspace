---
changelog: platform
section: Fixed
---

- Browsing or testing a `file://` storage connection maps the folder's own failures explicitly: a path outside the folder is `storage_connection_endpoint_forbidden` (a test answers `forbidden`), and an I/O failure or the listing's walk cap is `storage_connection_unreachable`. Each is logged as a warning with its reason code only; the whole error, whose message names the customer's key, is no longer logged as unclassified. A run that cannot list a granted folder names the same class (#1835).
