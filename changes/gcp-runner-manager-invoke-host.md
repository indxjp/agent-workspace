---
changelog: platform
section: Security
---

- On the `gcp-cloudrun` target the runner manager may invoke only sandbox services: its invoke grant
  is now conditioned on the request's host (`rt-….run.app`) instead of the service name, which Cloud
  Run does not check when a service is invoked. The runner manager also refuses to call an agent
  sandbox whose URL is not an `https://rt-….run.app` address.
