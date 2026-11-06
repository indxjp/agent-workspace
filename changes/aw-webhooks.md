---
changelog: aw
section: Added
---

- `aw webhooks list | create | remove` (N-3, issue #250). `aw webhooks create --webhook-url <url>
  [--event <type> …]` (or `--file <json>`) prints the signing secret once, in its answer and under
  `--json`, with a warning on stderr; `--url` stays the control plane's flag.
