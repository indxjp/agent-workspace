---
changelog: platform
section: Changed
---

- On Linux, a `file://` storage connection follows a directory symlink that stays inside the connection's folder: it is listed, read, written and deleted through like the folder it names. A listing counts, and does not enter, a link back to a folder it is inside. File symlinks, links that lead outside the folder, and every link on hosts without `/proc/self/fd` are still refused (#1835).
