---
changelog: platform
section: Changed
---

- Web stops at start-up, exiting with status 1 and logging each refused variable and the value it
  expects, when `AW_TRUSTED_PROXY_HOPS` is not `0` to `16` or `AW_CONTAINER_IDLE_STOP_SECONDS` is not
  whole seconds above 15. Before, a malformed proxy count was silently read as "no proxy", so
  every visitor shared one rate-limit bucket and runnable public links refused to run, and a
  malformed idle stop meant no run limit, so a Cloudflare Container could stop in the middle of a
  run. Unset values and `0` for the proxy count work as before.
