---
changelog: platform
section: Security
---

- On Windows, a `file://` storage connection refuses a key that NTFS would read as another name or a device: an alternate data stream (`a.txt:s`, `a.txt::$DATA`), a trailing dot or space, a device name such as `nul` or `con.txt`, or a Win32 wildcard character. Such names are left out of listings, and a write no longer tries to flush the folder, which Windows cannot do (#1835).
