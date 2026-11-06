---
changelog: sdk
section: Changed
---

- `runs.follow` backs off between reconnects (issue #250, K-3): the base is the last `retry:` the
  stream sent, or `reconnectDelayMs` before one arrives; the n-th failed reconnect in a row waits a
  random time between half and all of `min(maxReconnectDelayMs, base × 2^(n−1))`, and a connection
  that delivers a new event starts the count again. A `429` or `5xx` with `Retry-After` is still
  waited exactly that long. The new `maxReconnectDelayMs` option is the ceiling, default 30000.
  `reconnectDelayMs` and `maxReconnectDelayMs` must be non-negative finite numbers with
  `reconnectDelayMs ≤ maxReconnectDelayMs`; anything else throws a `TypeError` before the first
  request.
